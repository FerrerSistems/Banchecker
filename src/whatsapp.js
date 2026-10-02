/**
 * MÓDULO DE WHATSAPP — v4 FINAL
 * - isRegisteredUser() como método PRINCIPAL (oficial)
 * - protocolTimeout alto (10 min) para evitar CDP hangs
 * - Health check antes de cada operación
 * - Auto-restart si el page está colgado
 * - Full debug con stack traces
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
const config = require('./config');
const { dbg } = config;

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// ESTADO GLOBAL
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

// Mutex para serializar checks
let checkLock = Promise.resolve();

// ══════════════════════════════════════════
// STATS
// ══════════════════════════════════════════

const stats = {
  totalChecks: 0,
  successChecks: 0,
  failedChecks: 0,
  timeoutChecks: 0,
  restarts: 0,
  pageHealthchecksOK: 0,
  pageHealthchecksFail: 0,
  avgCheckMs: 0,
  lastCheckMs: 0,
  peakHeapMB: 0,
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
  const sec = s % 60;
  return `${h}h${m}m${sec}s`;
}

function log(tag, msg, data) {
  const m = memInfo();
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] [heap:${m.heap}MB rss:${m.rss}MB up:${uptime()}] ${msg}${extra}`);
  const heapNum = parseFloat(m.heap);
  if (heapNum > stats.peakHeapMB) stats.peakHeapMB = heapNum;
}

function logError(tag, msg, err) {
  const m = memInfo();
  console.error(`[${new Date().toISOString()}] [${tag}] [heap:${m.heap}MB rss:${m.rss}MB] ❌ ${msg}`);
  if (err) {
    if (err.name) console.error(`[${tag}]   name: ${err.name}`);
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.label) console.error(`[${tag}]   label: ${err.label}`);
    if (err.elapsedMs) console.error(`[${tag}]   elapsedMs: ${err.elapsedMs}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(0, 6);
      lines.forEach(l => console.error(`[${tag}]   ${l.trim()}`));
    }
  }
}

// ══════════════════════════════════════════
// TIMEOUT CANCELABLE
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
      logError('TIMEOUT', `"${label}" TIMEOUT en ${err.elapsedMs}ms`, err);
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
      // Silenciar errores tardíos
      log('TIMEOUT', `Error tardío en "${label}" ignorado: ${e.message}`);
    });
  });
}

// ══════════════════════════════════════════
// HEALTH CHECK DE LA PÁGINA
// ══════════════════════════════════════════

async function healthCheckPage() {
  if (!client || !client.pupPage) {
    log('HEALTH', 'No hay pupPage');
    return false;
  }

  try {
    const start = Date.now();
    const result = await withTimeout(
      client.pupPage.evaluate(() => 2 + 2),
      5000,
      'healthcheck'
    );
    const elapsed = Date.now() - start;

    if (result === 4) {
      stats.pageHealthchecksOK++;
      log('HEALTH', `✅ Página responde en ${elapsed}ms`);
      return true;
    }

    stats.pageHealthchecksFail++;
    logError('HEALTH', `Página devolvió ${result} (esperado 4)`);
    return false;
  } catch (e) {
    stats.pageHealthchecksFail++;
    logError('HEALTH', `❌ Página NO responde: ${e.message}`);
    return false;
  }
}

// ══════════════════════════════════════════
// CREAR CLIENTE
// ══════════════════════════════════════════

function createClient() {
  log('WHATSAPP', '═══════ CREANDO CLIENTE ═══════');

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
  log('WHATSAPP', `Chrome: ${chromePath}`);

  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.sessionId,
      dataPath: config.whatsapp.sessionPath,
    }),
    puppeteer: {
      executablePath: chromePath,
      headless: true,
      // ⭐ CRÍTICO: Aumentar protocolTimeout para evitar "Runtime.callFunctionOn timed out"
      protocolTimeout: 600000, // 10 minutos
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
        // Reducir memoria de Chrome
        '--single-process',
        '--disable-features=site-per-process,IsolateOrigins',
      ],
    },
  });

  log('WHATSAPP', '✅ Cliente creado, registrando eventos...');

  // ══════════════════════════════════════════
  // EVENTOS
  // ══════════════════════════════════════════

  newClient.on('qr', async (qr) => {
    log('WHATSAPP', `📲 QR (length: ${qr.length})`);
    currentQR = qr;
    try {
      const QRCode = require('qrcode');
      currentQRBuffer = await QRCode.toBuffer(qr, {
        type: 'png', width: 600, margin: 2,
        errorCorrectionLevel: 'M',
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

    const info = newClient.info;
    log('WHATSAPP', `Número: +${info?.wid?.user}`);
    log('WHATSAPP', `Nombre: ${info?.pushname}`);
    log('WHATSAPP', `Init total: ${((Date.now() - initStartTime) / 1000).toFixed(1)}s`);

    emitter.emit('ready', info);
    readyResolvers.forEach(r => r(newClient));
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    logError('WHATSAPP', `DESCONECTADO: ${reason}`);
    isReady = false;
    isInitializing = false;
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
// INICIALIZAR
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  log('WHATSAPP', '═══════ INICIALIZANDO ═══════');

  if (client && isReady) return client;
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

  try {
    client = createClient();
  } catch (e) {
    isInitializing = false;
    initError = e.message;
    throw e;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logError('WHATSAPP', `TIMEOUT init 5min. Último evento: N/A`);
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
// RESTART
// ══════════════════════════════════════════

async function restartForQR() {
  log('WHATSAPP', '═══════ RESTART PARA QR ═══════');
  stats.restarts++;

  try {
    if (client) {
      try { await client.destroy(); } catch (e) {}
    }

    client = null;
    isReady = false;
    isInitializing = false;
    currentQR = null;
    currentQRBuffer = null;
    initError = null;

    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {}
    }

    return await initializeWhatsApp();
  } catch (e) {
    logError('WHATSAPP', 'Error restartForQR', e);
    throw e;
  }
}

async function getReadyClient() {
  if (client && isReady) return client;
  if (!client || !isInitializing) return initializeWhatsApp();
  return new Promise((resolve) => {
    readyResolvers.push(() => resolve(client));
  });
}

// ══════════════════════════════════════════
// VERIFICAR ESTADO DE UN NÚMERO
// Solo usa isRegisteredUser() — método oficial
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  // Serializar checks: solo uno a la vez
  const release = await acquireLock();

  const start = Date.now();
  stats.totalChecks++;

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `Check #${stats.totalChecks} | ready=${isReady}`);
  log('CHECK', '════════════════════════════════════════');

  try {
    // ══════════════════════════════════════════
    // PASO 0: ¿Está conectado?
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
    const numberOnly = phone;

    // ══════════════════════════════════════════
    // PASO 1: Health check de la página
    // ══════════════════════════════════════════
    log('CHECK', '[PASO 1/3] Health check de la página...');
    const healthy = await healthCheckPage();

    if (!healthy) {
      logError('CHECK', 'Página no responde. Necesita restart.');

      // Programar restart (sin bloquear la respuesta al usuario)
      setImmediate(async () => {
        log('CHECK', 'Programando restart por página no responde...');
        try {
          await restartForQR();
        } catch (e) {
          logError('CHECK', 'Error en restart automático', e);
        }
      });

      return {
        status: 'ERROR',
        message: '⚠️ WhatsApp no responde. Reiniciando...\n\nIntenta de nuevo en 1-2 minutos.',
        raw: { reason: 'page_unresponsive' },
      };
    }

    log('CHECK', '[PASO 1/3] ✅ Página OK');

    // ══════════════════════════════════════════
    // PASO 2: isRegisteredUser (método OFICIAL)
    // ══════════════════════════════════════════
    log('CHECK', `[PASO 2/3] isRegisteredUser(${numberOnly})...`);

    let isRegistered = null;
    let checkMethod = 'isRegisteredUser';

    try {
      const t0 = Date.now();
      isRegistered = await withTimeout(
        c.isRegisteredUser(chatId),
        30000,
        'isRegisteredUser'
      );
      const elapsed = Date.now() - t0;
      log('CHECK', `✅ isRegisteredUser → ${isRegistered} (${elapsed}ms)`);
    } catch (e) {
      logError('CHECK', `isRegisteredUser falló`, e);

      // Fallback: getNumberId
      log('CHECK', `Fallback: getNumberId(${numberOnly})...`);
      checkMethod = 'getNumberId';

      try {
        const t0 = Date.now();
        const numberId = await withTimeout(
          c.getNumberId(numberOnly),
          30000,
          'getNumberId'
        );
        const elapsed = Date.now() - t0;

        isRegistered = !!numberId;
        log('CHECK', `✅ getNumberId → ${isRegistered ? numberId._serialized : 'null'} (${elapsed}ms)`);
      } catch (e2) {
        logError('CHECK', `getNumberId también falló`, e2);

        const totalElapsed = Date.now() - start;

        // Programar restart si ambos fallan
        setImmediate(async () => {
          log('CHECK', 'Ambos métodos fallaron. Programando restart...');
          try { await restartForQR(); } catch (e) {}
        });

        return {
          status: 'ERROR',
          message: `⏱️ WhatsApp no responde (${(totalElapsed / 1000).toFixed(1)}s). Reiniciando...\n\nIntenta en 1-2 minutos.`,
          raw: { error1: e.message, error2: e2.message, elapsedMs: totalElapsed },
        };
      }
    }

    // ══════════════════════════════════════════
    // PASO 3: Interpretar
    // ══════════════════════════════════════════
    const totalElapsed = Date.now() - start;
    stats.lastCheckMs = totalElapsed;
    stats.avgCheckMs = stats.avgCheckMs === 0
      ? totalElapsed
      : (stats.avgCheckMs + totalElapsed) / 2;

    if (isRegistered === false) {
      log('CHECK', `❌ NO registrado → PERMANENT_BAN (${totalElapsed}ms)`);
      stats.failedChecks++;

      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isRegistered: false, method: checkMethod, elapsedMs: totalElapsed },
      };
    }

    log('CHECK', `✅ ACTIVO (${totalElapsed}ms) — método: ${checkMethod}`);
    stats.successChecks++;

    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: { isRegistered: true, method: checkMethod, elapsedMs: totalElapsed },
    };
  } catch (e) {
    logError('CHECK', 'Error general', e);
    stats.failedChecks++;

    const elapsed = Date.now() - start;
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
// MUTEX SIMPLE
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
  }
}

function getDiagnostics() {
  return {
    ready: isReady,
    initializing: isInitializing,
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
