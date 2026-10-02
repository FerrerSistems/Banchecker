/**
 * MÓDULO DE WHATSAPP — v5 CORREGIDO
 * - NO borra la sesión cuando la página se rompe
 * - reconnect() preserva la sesión
 * - restartForQR() solo se llama desde /session (borra sesión)
 * - checkNumberStatus sin health check destructivo
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
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
let reconnecting = false;

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
  avgCheckMs: 0,
  lastCheckMs: 0,
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
// DETECCIÓN DE ERRORES DE PÁGINA
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
    msg.includes('navigation failed') ||
    msg.includes('runtime.callfunctionon timed out')
  );
}

// ══════════════════════════════════════════
// CREAR CLIENTE (con o sin sesión)
// ══════════════════════════════════════════

function createClient(clearSession = false) {
  log('WHATSAPP', `═══════ CREANDO CLIENTE (clearSession=${clearSession}) ═══════`);

  let chromePath = config.whatsapp.chromePath;

  if (!chromePath) {
    const paths = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium',
    ];
    for (const p of paths) {
      try { if (fs.existsSync(p)) { chromePath = p; break; } } catch (e) {}
    }
  }

  if (!chromePath) throw new Error('Chrome no encontrado');

  // Si clearSession, borrar antes de crear
  if (clearSession) {
    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      log('WHATSAPP', '🗑️ Limpiando sesión local (clearSession=true)');
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {
        logError('WHATSAPP', 'Error limpiando sesión', e);
      }
    }
  } else {
    log('WHATSAPP', '📁 Preservando sesión local');
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

  // ══════════════════════════════════════════
  // EVENTOS
  // ══════════════════════════════════════════

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
    emitter.emit('authenticated');
  });

  newClient.on('auth_failure', (msg) => {
    logError('WHATSAPP', `FALLO AUTH: ${msg}`);
    isReady = false;
    initError = `Auth failure: ${msg}`;
    emitter.emit('auth_failure', msg);
  });

  newClient.on('ready', () => {
    log('WHATSAPP', '═══════ ✅ CLIENTE LISTO ═══════');
    isReady = true;
    isInitializing = false;
    reconnecting = false;

    const info = newClient.info;
    log('WHATSAPP', `Número: +${info?.wid?.user}`);
    log('WHATSAPP', `Nombre: ${info?.pushname}`);

    emitter.emit('ready', info);
    readyResolvers.forEach(r => r(newClient));
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    logError('WHATSAPP', `DESCONECTADO: ${reason}`);
    isReady = false;
    isInitializing = false;
    reconnecting = false;
    client = null;
    emitter.emit('disconnected', reason);
  });

  newClient.on('error', (err) => {
    logError('WHATSAPP', `EVENTO ERROR: ${err.message}`, err);
    initError = err.message;
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR (con o sin limpiar sesión)
// ══════════════════════════════════════════

async function initializeWhatsApp(clearSession = false) {
  log('WHATSAPP', `═══════ INICIALIZANDO (clearSession=${clearSession}) ═══════`);

  if (client && isReady && !clearSession) return client;

  if (isInitializing) {
    log('WHATSAPP', 'Ya inicializando, esperando...');
    return new Promise((resolve) => {
      readyResolvers.push(() => resolve(client));
    });
  }

  initAttempts++;
  log('WHATSAPP', `Intento #${initAttempts}`);
  isInitializing = true;
  initStartTime = Date.now();
  initError = null;

  // Destruir cliente previo si existe
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
      logError('WHATSAPP', `TIMEOUT init 5min`);
      isInitializing = false;
      reject(new Error('Timeout init'));
    }, 5 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      resolve(client);
    });

    client.initialize()
      .then(() => log('WHATSAPP', 'client.initialize() OK'))
      .catch((e) => {
        logError('WHATSAPP', 'initialize() falló', e);
        clearTimeout(timeout);
        isInitializing = false;
        initError = e.message;
        reject(e);
      });
  });
}

// ══════════════════════════════════════════
// RECONNECT — preserva la sesión
// ══════════════════════════════════════════

async function reconnect() {
  if (reconnecting) {
    log('WHATSAPP', 'Reconnect ya en progreso, esperando...');
    return new Promise((resolve) => {
      readyResolvers.push(() => resolve(client));
    });
  }

  log('WHATSAPP', '═══════ RECONNECT (preservando sesión) ═══════');
  reconnecting = true;
  stats.reconnects++;

  try {
    return await initializeWhatsApp(false); // ← NO borra sesión
  } catch (e) {
    logError('WHATSAPP', 'Error en reconnect', e);
    reconnecting = false;
    throw e;
  }
}

// ══════════════════════════════════════════
// RESTART FOR QR — solo desde /session
// ══════════════════════════════════════════

async function restartForQR() {
  log('WHATSAPP', '═══════ RESTART PARA QR (borrando sesión) ═══════');
  stats.qrRegens++;

  try {
    if (client) {
      try { await client.destroy(); } catch (e) {}
    }
    client = null;
    isReady = false;
    isInitializing = false;
    reconnecting = false;
    currentQR = null;
    currentQRBuffer = null;
    initError = null;

    return await initializeWhatsApp(true); // ← SÍ borra sesión
  } catch (e) {
    logError('WHATSAPP', 'Error en restartForQR', e);
    throw e;
  }
}

// ══════════════════════════════════════════
// GET READY CLIENT
// ══════════════════════════════════════════

async function getReadyClient() {
  if (client && isReady) return client;
  if (!client || (!isInitializing && !reconnecting)) return initializeWhatsApp(false);
  return new Promise((resolve) => {
    readyResolvers.push(() => resolve(client));
  });
}

// ══════════════════════════════════════════
// CHECK NUMBER STATUS — CORREGIDO
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const release = await acquireLock();
  const start = Date.now();
  stats.totalChecks++;

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `Check #${stats.totalChecks} | ready=${isReady}`);
  log('CHECK', '════════════════════════════════════════');

  try {
    // ══════════════════════════════════════════
    // PASO 0: ¿Conectado?
    // ══════════════════════════════════════════
    if (!isReady || !client) {
      const msg = currentQRBuffer
        ? '🔌 WhatsApp no conectado. Hay un QR pendiente — usa /session'
        : '🔌 WhatsApp no conectado. Usa /session para conectar.';

      return {
        status: 'NOT_CONNECTED',
        message: msg,
        raw: { ready: isReady, hasQR: !!currentQRBuffer },
      };
    }

    const c = client;
    const chatId = `${phone}@c.us`;

    // ══════════════════════════════════════════
    // PASO 1: isRegisteredUser (método oficial)
    // ══════════════════════════════════════════
    log('CHECK', `[PASO 1/2] isRegisteredUser(${phone})...`);

    let isRegistered = null;
    let checkMethod = 'isRegisteredUser';

    try {
      const t0 = Date.now();
      isRegistered = await withTimeout(
        c.isRegisteredUser(chatId),
        25000,
        'isRegisteredUser'
      );
      const elapsed = Date.now() - t0;
      log('CHECK', `✅ isRegisteredUser → ${isRegistered} (${elapsed}ms)`);
    } catch (e) {
      logError('CHECK', `isRegisteredUser falló`, e);

      // ⭐ Si la página está rota, reconnect en background (SIN borrar sesión)
      if (isPageBroken(e)) {
        log('CHECK', '⚠️ Página rota. Programando reconnect (preservando sesión)...');
        setImmediate(() => {
          reconnect().catch(err => logError('CHECK', 'Error reconnect', err));
        });

        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp se desconectó. Reconectando...\n\nIntenta en 30 segundos.',
          raw: { reason: 'page_broken', error: e.message },
        };
      }

      // Fallback: getNumberId
      log('CHECK', `Fallback: getNumberId(${phone})...`);
      checkMethod = 'getNumberId';

      try {
        const t0 = Date.now();
        const numberId = await withTimeout(
          c.getNumberId(phone),
          25000,
          'getNumberId'
        );
        const elapsed = Date.now() - t0;

        isRegistered = !!numberId;
        log('CHECK', `✅ getNumberId → ${isRegistered ? numberId._serialized : 'null'} (${elapsed}ms)`);
      } catch (e2) {
        logError('CHECK', `getNumberId también falló`, e2);

        if (isPageBroken(e2)) {
          log('CHECK', '⚠️ Página rota. Programando reconnect...');
          setImmediate(() => {
            reconnect().catch(err => logError('CHECK', 'Error reconnect', err));
          });

          return {
            status: 'ERROR',
            message: '⚠️ WhatsApp se desconectó. Reconectando...\n\nIntenta en 30 segundos.',
            raw: { reason: 'page_broken', error: e2.message },
          };
        }

        const totalElapsed = Date.now() - start;
        return {
          status: 'ERROR',
          message: `⏱️ WhatsApp no responde (${(totalElapsed / 1000).toFixed(1)}s). Intenta de nuevo.`,
          raw: { error1: e.message, error2: e2.message, elapsedMs: totalElapsed },
        };
      }
    }

    // ══════════════════════════════════════════
    // PASO 2: Interpretar
    // ══════════════════════════════════════════
    const elapsed = Date.now() - start;
    stats.lastCheckMs = elapsed;
    stats.avgCheckMs = stats.avgCheckMs === 0 ? elapsed : (stats.avgCheckMs + elapsed) / 2;

    if (isRegistered === false) {
      log('CHECK', `❌ NO registrado → PERMANENT_BAN (${elapsed}ms)`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isRegistered: false, method: checkMethod, elapsedMs: elapsed },
      };
    }

    log('CHECK', `✅ ACTIVO (${elapsed}ms) — método: ${checkMethod}`);
    stats.successChecks++;

    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: { isRegistered: true, method: checkMethod, elapsedMs: elapsed },
    };
  } catch (e) {
    logError('CHECK', 'Error general', e);
    stats.failedChecks++;
    const elapsed = Date.now() - start;

    if (isPageBroken(e)) {
      setImmediate(() => {
        reconnect().catch(err => logError('CHECK', 'Error reconnect', err));
      });
    }

    return {
      status: 'ERROR',
      message: `❌ Error: ${e.message}`,
      raw: { error: e.message, elapsedMs: elapsed },
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
  return result.status === 'PERMANENT_BAN';
}

async function destroyClient() {
  if (client) {
    try { await client.destroy(); } catch (e) {}
    client = null;
    isReady = false;
    isInitializing = false;
    reconnecting = false;
  }
}

function getDiagnostics() {
  return {
    ready: isReady,
    initializing: isInitializing,
    reconnecting,
    hasQR: !!currentQRBuffer,
    initError,
    initAttempts,
    hasClient: !!client,
    stats: { ...stats },
    uptime: uptime(),
    memory: memInfo(),
  };
}

function getQRBuffer() { return currentQRBuffer; }
function hasQR() { return !!currentQRBuffer; }
function clearQR() { currentQR = null; currentQRBuffer = null; }
function getStats() { return { ...stats }; }

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
  emitter,
};
