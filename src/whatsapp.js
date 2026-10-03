/**
 * MÓDULO WHATSAPP — v9 FINAL
 * - Watchdog de página cada 30s
 * - Solo getNumberId (más ligero)
 * - Reconnect automático si la página se atasca
 * - Cola serial (nunca 2 checks a la vez)
 * - Interpretación correcta de timeouts
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════

let client = null;
let isReady = false;
let readyResolvers = [];
let currentQR = null;
let currentQRBuffer = null;
let isInitializing = false;
let initStartTime = null;
let initError = null;
let initAttempts = 0;
let reconnectAttempts = 0;
let lastAuthFailure = null;
let lastDisconnectReason = null;

// Watchdog
let watchdogInterval = null;
let pageHealthy = true;
let consecutiveHealthFailures = 0;
let lastHealthCheck = null;

let checkLock = Promise.resolve();

// ══════════════════════════════════════════
// STATS
// ══════════════════════════════════════════

const stats = {
  totalChecks: 0,
  successChecks: 0,
  failedChecks: 0,
  reconnects: 0,
  qrRegens: 0,
  watchdogChecks: 0,
  watchdogFails: 0,
  pageReconnects: 0,
  avgCheckMs: 0,
  startTime: Date.now(),
};

// ══════════════════════════════════════════
// LOGGING
// ══════════════════════════════════════════

function memInfo() {
  const m = process.memoryUsage();
  return {
    heap: (m.heapUsed / 1024 / 1024).toFixed(1),
    rss: (m.rss / 1024 / 1024).toFixed(1),
  };
}

function uptime() {
  const s = Math.floor(process.uptime());
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h${m}m${s % 60}s`;
}

function log(tag, msg, data) {
  const m = memInfo();
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] [heap:${m.heap}MB up:${uptime()}] ${msg}${extra}`);
}

function logError(tag, msg, err) {
  const m = memInfo();
  console.error(`[${new Date().toISOString()}] [${tag}] [heap:${m.heap}MB] ❌ ${msg}`);
  if (err) {
    if (err.name) console.error(`[${tag}]   name: ${err.name}`);
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.label) console.error(`[${tag}]   label: ${err.label}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(0, 5);
      lines.forEach(l => console.error(`[${tag}]   ${l.trim()}`));
    }
  }
}

// ══════════════════════════════════════════
// TIMEOUT
// ══════════════════════════════════════════

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const start = Date.now();
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`TIMEOUT_${label}`);
      err.isTimeout = true;
      err.label = label;
      err.elapsedMs = Date.now() - start;
      logError('TIMEOUT', `"${label}" TIMEOUT en ${err.elapsedMs}ms`);
      reject(err);
    }, ms);

    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(e);
      }
    ).catch((e) => {
      log('TIMEOUT', `Error tardío en "${label}": ${e.message}`);
    });
  });
}

// ══════════════════════════════════════════
// DETECCIÓN
// ══════════════════════════════════════════

function isPageBroken(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  return (
    msg.includes('detached frame') ||
    msg.includes('target closed') ||
    msg.includes('session closed') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('page crashed') ||
    msg.includes('protocol error') ||
    msg.includes('runtime.callfunctionon timed out')
  );
}

function classifyWhatsAppError(errMsg) {
  if (!errMsg) return null;
  const m = String(errMsg).toLowerCase();
  if (m.includes('request review') || m.includes('under review')) return 'TEMPORARY_BAN';
  if (m.includes('ban spam') || m.includes('spam ban')) return 'SPAM_BAN';
  if (m.includes('not registered') || m.includes('invalid number')) return 'PERMANENT_BAN';
  if (m.includes('account restricted') || m.includes('suspended') || m.includes('banned')) return 'PERMANENT_BAN';
  return null;
}

// ══════════════════════════════════════════
// SESIÓN EN DISCO
// ══════════════════════════════════════════

function hasSessionOnDisk() {
  try {
    const sessionDir = config.whatsapp.sessionPath;
    const sessionId = config.whatsapp.sessionId;
    const laDir = path.join(sessionDir, `session-${sessionId}`);
    if (!fs.existsSync(laDir)) return false;
    const defaultDir = path.join(laDir, 'Default');
    if (!fs.existsSync(defaultDir)) return false;
    const localState = path.join(defaultDir, 'Local Storage');
    const preferences = path.join(defaultDir, 'Preferences');
    return fs.existsSync(localState) || fs.existsSync(preferences);
  } catch (e) {
    return false;
  }
}

// ══════════════════════════════════════════
// ⭐ HEALTH CHECK (rápido, ligero)
// ══════════════════════════════════════════

async function healthCheckPage() {
  if (!client || !client.pupPage) return false;

  try {
    const result = await withTimeout(
      client.pupPage.evaluate(() => 1 + 1),
      4000,
      'health_check'
    );
    return result === 2;
  } catch (e) {
    return false;
  }
}

// ══════════════════════════════════════════
// ⭐ WATCHDOG (vigila la página cada 30s)
// ══════════════════════════════════════════

function startWatchdog() {
  if (watchdogInterval) return;
  log('WATCHDOG', 'Iniciando watchdog (cada 30s)');

  watchdogInterval = setInterval(async () => {
    if (!isReady || !client) return;

    stats.watchdogChecks++;
    const healthy = await healthCheckPage();
    lastHealthCheck = new Date();

    if (healthy) {
      if (!pageHealthy) {
        log('WATCHDOG', '✅ Página recuperada');
        pageHealthy = true;
      }
      consecutiveHealthFailures = 0;
    } else {
      consecutiveHealthFailures++;
      stats.watchdogFails++;
      log('WATCHDOG', `⚠️ Página no responde (fallo ${consecutiveHealthFailures}/2)`);

      if (consecutiveHealthFailures >= 2 && pageHealthy) {
        pageHealthy = false;
        log('WATCHDOG', '🚨 Página MUERTA. Programando reconnect...');

        setImmediate(async () => {
          try {
            await reconnect();
          } catch (e) {
            logError('WATCHDOG', 'Error reconnect', e);
          }
        });
      }
    }
  }, 30000);
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    log('WATCHDOG', '⏹️ Watchdog detenido');
  }
}

// ══════════════════════════════════════════
// CREAR CLIENTE
// ══════════════════════════════════════════

function createClient(clearSession = false) {
  log('WHATSAPP', `═══ CREANDO CLIENTE (clearSession=${clearSession}) ═══`);

  let chromePath = config.whatsapp.chromePath;
  if (!chromePath) {
    for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
      try { if (fs.existsSync(p)) { chromePath = p; break; } } catch (e) {}
    }
  }
  if (!chromePath) throw new Error('Chrome no encontrado');

  if (clearSession) {
    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      log('WHATSAPP', '🗑️ Limpiando sesión (clearSession=true)');
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {}
    }
  } else {
    log('WHATSAPP', `📁 Preservando sesión. Existe: ${hasSessionOnDisk()}`);
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.sessionId,
      dataPath: config.whatsapp.sessionPath,
    }),
    puppeteer: {
      executablePath: chromePath,
      headless: true,
      protocolTimeout: 600000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
      ],
    },
  });

  log('WHATSAPP', '✅ Cliente creado');

  newClient.on('qr', async (qr) => {
    log('WHATSAPP', `📲 QR (length: ${qr.length})`);
    currentQR = qr;
    try {
      const QRCode = require('qrcode');
      currentQRBuffer = await QRCode.toBuffer(qr, {
        type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'M',
      });
      log('WHATSAPP', `💾 QR buffer: ${(currentQRBuffer.length / 1024).toFixed(1)}KB`);
    } catch (e) {
      logError('WHATSAPP', 'Error buffer QR', e);
      currentQRBuffer = null;
    }
  });

  newClient.on('loading_screen', (percent, message) => {
    log('WHATSAPP', `⏳ ${percent}% — ${message}`);
  });

  newClient.on('change_state', (state) => {
    log('WHATSAPP', `🔄 Estado: ${state}`);
  });

  newClient.on('authenticated', () => {
    log('WHATSAPP', '✅ AUTENTICADO');
    lastAuthFailure = null;
    emitter.emit('authenticated');
  });

  newClient.on('auth_failure', (msg) => {
    logError('WHATSAPP', `FALLO AUTH: ${msg}`);
    isReady = false;
    isInitializing = false;
    initError = `Auth failure: ${msg}`;
    lastAuthFailure = msg;
    emitter.emit('auth_failure', msg);
  });

  newClient.on('ready', () => {
    log('WHATSAPP', '═══════ ✅ CLIENTE LISTO ═══════');
    isReady = true;
    isInitializing = false;
    reconnectAttempts = 0;
    lastAuthFailure = null;
    pageHealthy = true;
    consecutiveHealthFailures = 0;

    const info = newClient.info;
    log('WHATSAPP', `Número: +${info?.wid?.user}`);
    log('WHATSAPP', `Nombre: ${info?.pushname}`);

    // Esperar 30s antes de considerar la página "usable"
    // (WhatsApp Web hace sync intenso los primeros segundos)
    log('WHATSAPP', '⏳ Esperando 30s de estabilización antes de marcar como usable...');
    setTimeout(() => {
      log('WHATSAPP', '✅ Página estable. Lista para consultas.');
      startWatchdog();
    }, 30000);

    emitter.emit('ready', info);
    readyResolvers.forEach(r => r(newClient));
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    logError('WHATSAPP', `DESCONECTADO: ${reason}`);
    isReady = false;
    isInitializing = false;
    lastDisconnectReason = reason;
    client = null;
    pageHealthy = false;
    stopWatchdog();
    emitter.emit('disconnected', reason);
  });

  newClient.on('error', (err) => {
    logError('WHATSAPP', `EVENTO ERROR: ${err.message}`, err);
    initError = err.message;
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR
// ══════════════════════════════════════════

async function initializeWhatsApp(clearSession = false) {
  log('WHATSAPP', `═══ INICIALIZANDO (clearSession=${clearSession}) ═══`);

  if (client && isReady && !clearSession) return client;

  if (isInitializing) {
    return new Promise((resolve) => {
      readyResolvers.push(() => resolve(client));
    });
  }

  initAttempts++;
  log('WHATSAPP', `Intento #${initAttempts}`);
  isInitializing = true;
  initStartTime = Date.now();
  initError = null;

  if (client) {
    log('WHATSAPP', 'Destruyendo cliente previo...');
    try { await client.destroy(); } catch (e) {}
    client = null;
    isReady = false;
  }

  try {
    client = createClient(clearSession);
  } catch (e) {
    isInitializing = false;
    initError = e.message;
    throw e;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logError('WHATSAPP', `TIMEOUT init 3min`);
      isInitializing = false;
      reject(new Error(`Timeout init: ${initError || 'sin error'}`));
    }, 3 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      resolve(client);
    });

    client.initialize()
      .then(() => log('WHATSAPP', 'client.initialize() resolvió'))
      .catch((e) => {
        logError('WHATSAPP', 'client.initialize() falló', e);
        clearTimeout(timeout);
        isInitializing = false;
        initError = e.message;
        reject(e);
      });
  });
}

async function reconnect() {
  reconnectAttempts++;
  log('WHATSAPP', `═══ RECONNECT (intento ${reconnectAttempts}) ═══`);
  stats.reconnects++;
  try {
    return await initializeWhatsApp(false);
  } catch (e) {
    logError('WHATSAPP', 'Reconnect falló', e);
    throw e;
  }
}

async function restartForQR() {
  log('WHATSAPP', '═══ RESTART PARA QR ═══');
  stats.qrRegens++;
  try {
    if (client) { try { await client.destroy(); } catch (e) {} }
    client = null;
    isReady = false;
    isInitializing = false;
    currentQR = null;
    currentQRBuffer = null;
    initError = null;
    reconnectAttempts = 0;
    return await initializeWhatsApp(true);
  } catch (e) {
    logError('WHATSAPP', 'Error restartForQR', e);
    throw e;
  }
}

async function getReadyClient() {
  if (client && isReady) return client;
  if (!client || !isInitializing) return initializeWhatsApp(false);
  return new Promise((resolve) => {
    readyResolvers.push(() => resolve(client));
  });
}

// ══════════════════════════════════════════
// ⭐ CHECK — v9
// 1. Health check rápido
// 2. Solo getNumberId con timeout corto
// 3. Timeout → SOSPECHOSO (podría ser suspendido O página atascada)
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const release = await acquireLock();
  const start = Date.now();
  stats.totalChecks++;

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `ready=${isReady} | pageHealthy=${pageHealthy}`);
  log('CHECK', '════════════════════════════════════════');

  try {
    // ────────────────────────────────────────
    // PASO 0: ¿Conectado?
    // ────────────────────────────────────────
    if ((!isReady || !client) && !isInitializing) {
      setImmediate(() => {
        reconnect().catch(e => logError('CHECK', 'Error reconnect', e));
      });
      return {
        status: 'NOT_CONNECTED',
        message: '🔄 WhatsApp reconectando...\n\n⏳ Espera 1-2 minutos.',
        raw: { ready: isReady, autoReconnect: true },
      };
    }

    if (isInitializing || (!isReady && client)) {
      const elapsed = initStartTime ? ((Date.now() - initStartTime) / 1000).toFixed(1) : '?';
      return {
        status: 'NOT_CONNECTED',
        message: `⏳ WhatsApp inicializando (${elapsed}s)...\n\nEspera 1-2 minutos.`,
        raw: { ready: isReady, initializing: isInitializing },
      };
    }

    const c = client;

    // ────────────────────────────────────────
    // PASO 1: Health check rápido (2s)
    // ────────────────────────────────────────
    log('CHECK', '[PASO 1/2] Health check...');
    const healthy = await healthCheckPage();

    if (!healthy) {
      log('CHECK', '⚠️ Página no responde. Reconnect programado.');

      setImmediate(async () => {
        try { await reconnect(); } catch (e) {}
      });

      return {
        status: 'ERROR',
        message: '⚠️ WhatsApp está reconectando. Intenta en 1-2 minutos.',
        raw: { reason: 'page_unhealthy', elapsedMs: Date.now() - start },
      };
    }

    log('CHECK', '[PASO 1/2] ✅ Página OK');

    // ────────────────────────────────────────
    // PASO 2: getNumberId (timeout 10s)
    // ────────────────────────────────────────
    log('CHECK', `[PASO 2/2] getNumberId(${phone})...`);

    let numberId = null;
    let checkError = null;

    try {
      const t0 = Date.now();
      numberId = await withTimeout(
        c.getNumberId(phone),
        10000,
        'getNumberId'
      );
      const elapsed = Date.now() - t0;
      log('CHECK', `✅ getNumberId → ${numberId ? numberId._serialized : 'null'} (${elapsed}ms)`);
    } catch (e) {
      checkError = e;
      logError('CHECK', 'getNumberId falló', e);

      if (isPageBroken(e)) {
        setImmediate(async () => {
          try { await reconnect(); } catch (err) {}
        });
        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp se desconectó. Reconectando...\n\nIntenta en 1-2 minutos.',
          raw: { reason: 'page_broken' },
        };
      }
    }

    const elapsed = Date.now() - start;
    stats.avgCheckMs = stats.avgCheckMs === 0 ? elapsed : (stats.avgCheckMs + elapsed) / 2;

    // ══════════════════════════════════════════
    // INTERPRETACIÓN
    // ══════════════════════════════════════════

    // ── Caso 1: getNumberId devolvió null → no registrado
    if (numberId === null && !checkError) {
      log('CHECK', `❌ getNumberId=null → PERMANENT_BAN (${elapsed}ms)`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isRegistered: false, elapsedMs: elapsed },
      };
    }

    // ── Caso 2: getNumberId devolvió ID → ACTIVO
    if (numberId && !checkError) {
      log('CHECK', `✅ ACTIVO (${elapsed}ms)`);
      stats.successChecks++;
      return {
        status: 'ACTIVE',
        message: '✅ Número activo',
        raw: { isRegistered: true, numberId: numberId._serialized, elapsedMs: elapsed },
      };
    }

    // ── Caso 3: getNumberId timeout → SOSPECHOSO
    // (el número podría estar suspendido O la página atascada)
    if (checkError && checkError.isTimeout) {
      log('CHECK', `⚠️ getNumberId timeout → verificar con health check...`);

      // Segundo health check para distinguir suspensión de página atascada
      const stillHealthy = await healthCheckPage();

      if (!stillHealthy) {
        log('CHECK', '❌ Página no responde tras timeout. Es problema de página.');
        setImmediate(async () => {
          try { await reconnect(); } catch (e) {}
        });
        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp está reconectando. Intenta en 1-2 minutos.',
          raw: { reason: 'page_unhealthy_after_timeout', elapsedMs: elapsed },
        };
      }

      // Página OK pero getNumberId timeout → SUSPENDIDO
      log('CHECK', `❌ Página OK pero getNumberId timeout → SUSPENDIDO (${elapsed}ms)`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Cuenta suspendida (WhatsApp no responde al número)',
        raw: {
          reason: 'getNumberId_timeout_but_page_ok',
          elapsedMs: elapsed,
        },
      };
    }

    // ── Caso 4: Otro error
    if (checkError) {
      const classified = classifyWhatsAppError(checkError.message);
      if (classified) {
        stats.failedChecks++;
        return {
          status: classified,
          message:
            classified === 'TEMPORARY_BAN' ? '⚠️ Baneo temporal' :
            classified === 'SPAM_BAN' ? '🚫 Ban por spam' :
            '❌ Cuenta suspendida',
          raw: { error: checkError.message, elapsedMs: elapsed },
        };
      }

      stats.failedChecks++;
      return {
        status: 'ERROR',
        message: `❌ Error: ${checkError.message}`,
        raw: { error: checkError.message, elapsedMs: elapsed },
      };
    }

    // Fallback
    return {
      status: 'UNKNOWN',
      message: '❓ Estado indeterminado',
      raw: { elapsedMs: elapsed },
    };

  } catch (e) {
    logError('CHECK', 'Error general', e);
    stats.failedChecks++;
    return {
      status: 'ERROR',
      message: `❌ Error: ${e.message}`,
      raw: { error: e.message },
    };
  } finally {
    release();
  }
}

// ══════════════════════════════════════════
// MUTEX
// ══════════════════════════════════════════

function acquireLock() {
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const current = checkLock;
  checkLock = checkLock.then(() => next);
  return current.then(() => release);
}

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

async function isNumberBanned(phone) {
  const result = await checkNumberStatus(phone);
  return result.status === 'PERMANENT_BAN' || result.status === 'SPAM_BAN';
}

async function destroyClient() {
  stopWatchdog();
  if (client) {
    try { await client.destroy(); } catch (e) {}
    client = null;
    isReady = false;
    isInitializing = false;
  }
}

function getDiagnostics() {
  return {
    ready: isReady,
    initializing: isInitializing,
    hasQR: !!currentQRBuffer,
    hasSession: hasSessionOnDisk(),
    initError,
    initAttempts,
    reconnectAttempts,
    hasClient: !!client,
    lastAuthFailure,
    lastDisconnectReason,
    pageHealthy,
    consecutiveHealthFailures,
    lastHealthCheck: lastHealthCheck?.toISOString() || null,
    stats: { ...stats },
    uptime: uptime(),
    memory: memInfo(),
  };
}

function getQRBuffer() { return currentQRBuffer; }
function hasQR() { return !!currentQRBuffer; }
function clearQR() { currentQR = null; currentQRBuffer = null; }
function getStats() { return { ...stats }; }
function hasSession() { return hasSessionOnDisk(); }

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = {
  createClient,
  initializeWhatsApp,
  reconnect,
  restartForQR,
  getReadyClient,
  checkNumberStatus,
  isNumberBanned,
  destroyClient,
  getClient: () => client,
  isReady: () => isReady,
  getQR: () => currentQR,
  getQRBuffer,
  hasQR,
  clearQR,
  getDiagnostics,
  getStats,
  hasSession,
  emitter,
};
