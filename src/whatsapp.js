/**
 * MÓDULO WHATSAPP — v10
 * - Health check + getNumberId + isRegisteredUser en cascada
 * - Distingue suspensión real de página atascada
 * - Watchdog + reconnect automático
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
  avgCheckMs: 0,
  startTime: Date.now(),
};

// ══════════════════════════════════════════
// LOGGING
// ══════════════════════════════════════════

function memInfo() {
  const m = process.memoryUsage();
  return { heap: (m.heapUsed / 1024 / 1024).toFixed(1), rss: (m.rss / 1024 / 1024).toFixed(1) };
}

function uptime() {
  const s = Math.floor(process.uptime());
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m${s % 60}s`;
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
      err.stack.split('\n').slice(0, 5).forEach(l => console.error(`[${tag}]   ${l.trim()}`));
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
      (v) => { if (!settled) { settled = true; clearTimeout(timeoutId); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timeoutId); reject(e); } }
    ).catch((e) => log('TIMEOUT', `Error tardío en "${label}": ${e.message}`));
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
    return fs.existsSync(path.join(defaultDir, 'Local Storage')) ||
           fs.existsSync(path.join(defaultDir, 'Preferences'));
  } catch (e) { return false; }
}

// ══════════════════════════════════════════
// HEALTH CHECK
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
// WATCHDOG
// ══════════════════════════════════════════

function startWatchdog() {
  if (watchdogInterval) return;
  log('WATCHDOG', 'Iniciando watchdog (30s)');

  watchdogInterval = setInterval(async () => {
    if (!isReady || !client) return;

    stats.watchdogChecks++;
    const healthy = await healthCheckPage();
    lastHealthCheck = new Date();

    if (healthy) {
      if (!pageHealthy) log('WATCHDOG', '✅ Página recuperada');
      pageHealthy = true;
      consecutiveHealthFailures = 0;
    } else {
      consecutiveHealthFailures++;
      stats.watchdogFails++;
      log('WATCHDOG', `⚠️ Fallo ${consecutiveHealthFailures}/2`);

      if (consecutiveHealthFailures >= 2 && pageHealthy) {
        pageHealthy = false;
        log('WATCHDOG', '🚨 Página MUERTA. Reconnect...');
        setImmediate(async () => {
          try { await reconnect(); } catch (e) { logError('WATCHDOG', 'Error reconnect', e); }
        });
      }
    }
  }, 30000);
}

function stopWatchdog() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
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
      log('WHATSAPP', '🗑️ Limpiando sesión');
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {}
    }
  } else {
    log('WHATSAPP', `📁 Preservando. Existe: ${hasSessionOnDisk()}`);
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
      logError('WHATSAPP', 'Error QR', e);
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

    log('WHATSAPP', '⏳ Esperando 30s de estabilización...');
    setTimeout(() => {
      log('WHATSAPP', '✅ Estable. Listo.');
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
    logError('WHATSAPP', `ERROR: ${err.message}`, err);
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
    return new Promise((resolve) => readyResolvers.push(() => resolve(client)));
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
      reject(new Error(`Timeout: ${initError || 'sin error'}`));
    }, 3 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      resolve(client);
    });

    client.initialize()
      .then(() => log('WHATSAPP', 'initialize() OK'))
      .catch((e) => {
        logError('WHATSAPP', 'initialize() falló', e);
        clearTimeout(timeout);
        isInitializing = false;
        initError = e.message;
        reject(e);
      });
  });
}

async function reconnect() {
  reconnectAttempts++;
  log('WHATSAPP', `═══ RECONNECT #${reconnectAttempts} ═══`);
  stats.reconnects++;
  try {
    return await initializeWhatsApp(false);
  } catch (e) {
    logError('WHATSAPP', 'Reconnect falló', e);
    throw e;
  }
}

async function restartForQR() {
  log('WHATSAPP', '═══ RESTART QR ═══');
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
  return new Promise((resolve) => readyResolvers.push(() => resolve(client)));
}

// ══════════════════════════════════════════
// ⭐ CHECK NUMBER STATUS v10
// Cascada: health → getNumberId → health → isRegisteredUser
// ══════════════════════════════════════════
async function checkNumberStatus(phone) {
  const release = await acquireLock();
  const start = Date.now();
  stats.totalChecks++;

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `ready=${isReady} | healthy=${pageHealthy}`);
  log('CHECK', '════════════════════════════════════════');

  try {
    // ══════════════════════════════════════════
    // PASO 0: ¿Conectado?
    // ══════════════════════════════════════════
    if ((!isReady || !client) && !isInitializing) {
      setImmediate(() => reconnect().catch(e => logError('CHECK', 'Reconnect', e)));
      return {
        status: 'NOT_CONNECTED',
        message: '🔄 WhatsApp reconectando...\n\nEspera 1-2 min.',
        raw: { autoReconnect: true },
      };
    }

    if (isInitializing || (!isReady && client)) {
      const elapsed = initStartTime ? ((Date.now() - initStartTime) / 1000).toFixed(1) : '?';
      return {
        status: 'NOT_CONNECTED',
        message: `⏳ Inicializando (${elapsed}s)...\n\nEspera 1-2 min.`,
        raw: { initializing: true },
      };
    }

    const c = client;

    // ══════════════════════════════════════════
    // PASO 1: Health check
    // ══════════════════════════════════════════
    log('CHECK', '[PASO 1/4] Health check...');
    const healthy1 = await healthCheckPage();

    if (!healthy1) {
      log('CHECK', '⚠️ Página no responde → reconnect');
      setImmediate(() => reconnect().catch(e => {}));
      return {
        status: 'ERROR',
        message: '⚠️ WhatsApp reconectando. Intenta en 1-2 min.',
        raw: { reason: 'page_unhealthy' },
      };
    }
    log('CHECK', '[PASO 1/4] ✅ Página OK');

    // ══════════════════════════════════════════
    // PASO 2: ¿Existe el número? (getNumberId)
    // ══════════════════════════════════════════
    log('CHECK', `[PASO 2/4] getNumberId(${phone})...`);

    let numberId = null;
    let getNumberIdError = null;

    try {
      const t0 = Date.now();
      numberId = await withTimeout(c.getNumberId(phone), 10000, 'getNumberId');
      log('CHECK', `✅ getNumberId → ${numberId ? numberId._serialized : 'null'} (${Date.now() - t0}ms)`);
    } catch (e) {
      getNumberIdError = e;
      logError('CHECK', 'getNumberId falló', e);

      if (isPageBroken(e)) {
        setImmediate(() => reconnect().catch(e => {}));
        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp reconectando. Intenta en 1-2 min.',
          raw: { reason: 'page_broken' },
        };
      }
    }

    // Si getNumberId devolvió null → no existe
    if (numberId === null && !getNumberIdError) {
      log('CHECK', `❌ getNumberId=null → NO REGISTRADO`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isRegistered: false, elapsedMs: Date.now() - start },
      };
    }

    // Si getNumberId dio timeout/error → no concluyente
    if (getNumberIdError) {
      log('CHECK', `⚠️ getNumberId falló → no concluyente`);

      const healthy2 = await healthCheckPage();
      if (!healthy2) {
        setImmediate(() => reconnect().catch(e => {}));
        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp reconectando. Intenta en 1-2 min.',
          raw: { reason: 'page_unhealthy_after_timeout' },
        };
      }

      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Cuenta suspendida (getNumberId no responde)',
        raw: { reason: 'getNumberId_timeout', elapsedMs: Date.now() - start },
      };
    }

    // ══════════════════════════════════════════
    // PASO 3: Device Count Signature (LA CLAVE)
    // Consulta USync: cuántos dispositivos tiene vinculados
    // ══════════════════════════════════════════
    const targetId = numberId._serialized;
    log('CHECK', `[PASO 3/4] getContactDeviceCount(${targetId})...`);

    let deviceCount = null;
    let deviceCountError = null;

    try {
      const t0 = Date.now();
      deviceCount = await withTimeout(
        c.getContactDeviceCount(targetId),
        15000,
        'getContactDeviceCount'
      );
      log('CHECK', `✅ getContactDeviceCount → ${deviceCount} dispositivos (${Date.now() - t0}ms)`);
    } catch (e) {
      deviceCountError = e;
      logError('CHECK', 'getContactDeviceCount falló', e);

      if (isPageBroken(e)) {
        setImmediate(() => reconnect().catch(e => {}));
        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp reconectando. Intenta en 1-2 min.',
          raw: { reason: 'page_broken' },
        };
      }
    }

    const elapsed = Date.now() - start;

    // ══════════════════════════════════════════
    // PASO 4: Interpretar Device Count
    // ══════════════════════════════════════════

    // Si el método falló (versión antigua de whatsapp-web.js)
    if (deviceCountError) {
      log('CHECK', `⚠️ getContactDeviceCount no disponible: ${deviceCountError.message}`);

      // Fallback: asumir ACTIVO (no podemos verificar)
      log('CHECK', `⚠️ Fallback → asumiendo ACTIVO por getNumberId OK`);
      stats.successChecks++;
      return {
        status: 'ACTIVE',
        message: '✅ Número activo (verificación parcial)',
        raw: {
          numberId: targetId,
          deviceCountError: deviceCountError.message,
          elapsedMs: elapsed,
        },
      };
    }

    // ── 0 dispositivos → BANEADO
    if (deviceCount === 0) {
      log('CHECK', `❌ 0 dispositivos → BANEADO (${elapsed}ms)`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Cuenta suspendida o baneada (sin dispositivos vinculados)',
        raw: { deviceCount: 0, numberId: targetId, elapsedMs: elapsed },
      };
    }

    // ── 1 dispositivo → SOSPECHOSO
    if (deviceCount === 1) {
      log('CHECK', `⚠️ 1 dispositivo → SOSPECHOSO (${elapsed}ms)`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Cuenta suspendida (dispositivo genérico sin teléfono)',
        raw: { deviceCount: 1, numberId: targetId, elapsedMs: elapsed },
      };
    }

    // ── 2+ dispositivos → ACTIVO
    log('CHECK', `✅ ${deviceCount} dispositivos → ACTIVO (${elapsed}ms)`);
    stats.successChecks++;
    return {
      status: 'ACTIVE',
      message: `✅ Número activo (${deviceCount} dispositivos)`,
      raw: { deviceCount, numberId: targetId, elapsedMs: elapsed },
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
