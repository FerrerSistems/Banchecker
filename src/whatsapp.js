/**
 * MÓDULO WHATSAPP — v7 CON DETECCIÓN DE SUSPENSIÓN
 * - isRegisteredUser: verifica que el número exista
 * - getContactById: verifica que la cuenta esté ACTIVA (no suspendida)
 * - Combina ambos para detectar: ACTIVO / SUSPENDIDO / BANEADO / TEMPORAL
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
// DETECCIÓN DE ERRORES
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
    msg.includes('protocol error')
  );
}

/**
 * Clasifica un error de WhatsApp Web en un estado.
 */
function classifyWhatsAppError(errMsg) {
  if (!errMsg) return null;
  const m = String(errMsg).toLowerCase();

  // Suspensión temporal
  if (m.includes('request review') || m.includes('under review') || m.includes('solicitar revisión')) {
    return 'TEMPORARY_BAN';
  }

  // Ban por spam
  if (m.includes('ban spam') || m.includes('spam ban')) {
    return 'SPAM_BAN';
  }

  // No registrado / eliminado
  if (m.includes('not registered') || m.includes('invalid number') || m.includes('number is not on whatsapp')) {
    return 'PERMANENT_BAN';
  }

  // Cuenta restringida
  if (m.includes('account restricted') || m.includes('suspended') || m.includes('banned')) {
    return 'PERMANENT_BAN';
  }

  return null;
}

// ══════════════════════════════════════════
// VERIFICAR SESIÓN EN DISCO
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
    lastDisconnectReason = reason;
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
// CHECK NUMBER STATUS — CON DOBLE VERIFICACIÓN
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const release = await acquireLock();
  const start = Date.now();
  stats.totalChecks++;

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `ready=${isReady} | initializing=${isInitializing}`);
  log('CHECK', '════════════════════════════════════════');

  try {
    // ══════════════════════════════════════════
    // PASO 0: ¿Conectado?
    // ══════════════════════════════════════════
    if ((!isReady || !client) && !isInitializing) {
      setImmediate(() => {
        reconnect().catch(e => logError('CHECK', 'Error reconnect', e));
      });

      return {
        status: 'NOT_CONNECTED',
        message: '🔄 WhatsApp reconectando...\n\n⏳ Espera 1-2 minutos y vuelve a intentar.',
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
    const chatId = `${phone}@c.us`;

    // ══════════════════════════════════════════
    // PASO 1: ¿Existe el número? (isRegisteredUser)
    // ══════════════════════════════════════════
    log('CHECK', `[PASO 1/2] isRegisteredUser(${phone})...`);

    let isRegistered = null;

    try {
      const t0 = Date.now();
      isRegistered = await withTimeout(
        c.isRegisteredUser(chatId),
        25000,
        'isRegisteredUser'
      );
      log('CHECK', `✅ isRegisteredUser → ${isRegistered} (${Date.now() - t0}ms)`);
    } catch (e) {
      logError('CHECK', 'isRegisteredUser falló', e);

      if (isPageBroken(e)) {
        setImmediate(() => {
          reconnect().catch(err => logError('CHECK', 'Error reconnect', err));
        });
        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp se desconectó. Reconectando...\n\nIntenta en 30 segundos.',
          raw: { reason: 'page_broken' },
        };
      }

      // Fallback: getNumberId
      try {
        const t0 = Date.now();
        const numberId = await withTimeout(
          c.getNumberId(phone),
          25000,
          'getNumberId'
        );
        isRegistered = !!numberId;
        log('CHECK', `✅ getNumberId → ${isRegistered} (${Date.now() - t0}ms)`);
      } catch (e2) {
        logError('CHECK', 'getNumberId falló', e2);

        if (isPageBroken(e2)) {
          setImmediate(() => {
            reconnect().catch(err => logError('CHECK', 'Error reconnect', err));
          });
        }

        const elapsed = Date.now() - start;
        return {
          status: 'ERROR',
          message: `⏱️ WhatsApp no responde (${(elapsed / 1000).toFixed(1)}s). Intenta de nuevo.`,
          raw: { error1: e.message, error2: e2.message, elapsedMs: elapsed },
        };
      }
    }

    if (isRegistered === false) {
      log('CHECK', `❌ NO registrado → PERMANENT_BAN`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isRegistered: false, elapsedMs: Date.now() - start },
      };
    }

    log('CHECK', `✅ Número existe. Verificando estado de cuenta...`);

    // ══════════════════════════════════════════
    // PASO 2: ¿La cuenta está ACTIVA? (getContactById)
    // Aquí se detecta suspensión
    // ══════════════════════════════════════════
    log('CHECK', `[PASO 2/2] getContactById(${phone})...`);

    let contact = null;
    let contactError = null;

    try {
      const t0 = Date.now();
      contact = await withTimeout(
        c.getContactById(chatId),
        20000,
        'getContactById'
      );
      log('CHECK', `✅ getContactById OK (${Date.now() - t0}ms)`);
      log('CHECK', `   isWAContact: ${contact.isWAContact}`);
      log('CHECK', `   isUser: ${contact.isUser}`);
      log('CHECK', `   isBusiness: ${contact.isBusiness}`);
      log('CHECK', `   isBlocked: ${contact.isBlocked}`);
      log('CHECK', `   name: ${contact.name}`);
      log('CHECK', `   pushname: ${contact.pushname}`);
      log('CHECK', `   number: ${contact.number}`);
    } catch (e) {
      contactError = e;
      logError('CHECK', 'getContactById falló', e);

      if (isPageBroken(e)) {
        setImmediate(() => {
          reconnect().catch(err => logError('CHECK', 'Error reconnect', err));
        });
        return {
          status: 'ERROR',
          message: '⚠️ WhatsApp se desconectó. Reconectando...\n\nIntenta en 30 segundos.',
          raw: { reason: 'page_broken' },
        };
      }

      // Clasificar el error
      const classified = classifyWhatsAppError(e.message);
      if (classified) {
        log('CHECK', `❌ Error clasificado: ${classified}`);
        stats.failedChecks++;
        return {
          status: classified,
          message:
            classified === 'TEMPORARY_BAN' ? '⚠️ Solicitar revisión — baneo temporal' :
            classified === 'SPAM_BAN' ? '🚫 Ban por spam detectado' :
            '❌ Cuenta suspendida o baneada',
          raw: { error: e.message, classified, elapsedMs: Date.now() - start },
        };
      }
    }

    const elapsed = Date.now() - start;
    stats.avgCheckMs = stats.avgCheckMs === 0 ? elapsed : (stats.avgCheckMs + elapsed) / 2;

    // ══════════════════════════════════════════
    // PASO 3: Interpretar resultado combinado
    // ══════════════════════════════════════════

    // Si getContactById devolvió un contacto:
    if (contact) {
      // ⭐ CASO CLAVE: isWAContact = false → suspendido o baneado
      if (contact.isWAContact === false) {
        log('CHECK', `❌ isWAContact=false → SUSPENDIDO/BANEADO (${elapsed}ms)`);
        stats.failedChecks++;
        return {
          status: 'PERMANENT_BAN',
          message: '❌ Cuenta suspendida o baneada (no es contacto activo de WhatsApp)',
          raw: {
            isRegistered: true,
            isWAContact: false,
            isUser: contact.isUser,
            isBusiness: contact.isBusiness,
            elapsedMs: elapsed,
          },
        };
      }

      // ⭐ CASO: Sin nombre → posible suspensión parcial
      const noName = !contact.name && !contact.pushname;
      if (noName && contact.isUser === false) {
        log('CHECK', `⚠️ Sin nombre y sin isUser → SUSPENDIDO (${elapsed}ms)`);
        stats.failedChecks++;
        return {
          status: 'PERMANENT_BAN',
          message: '❌ Cuenta suspendida (sin perfil activo)',
          raw: {
            isRegistered: true,
            isWAContact: contact.isWAContact,
            isUser: false,
            hasName: false,
            elapsedMs: elapsed,
          },
        };
      }

      // ✅ CASO: Todo OK
      log('CHECK', `✅ ACTIVO (${elapsed}ms) — nombre: ${contact.name || contact.pushname || 'sin nombre'}`);
      stats.successChecks++;
      return {
        status: 'ACTIVE',
        message: '✅ Número activo',
        raw: {
          isRegistered: true,
          isWAContact: contact.isWAContact,
          isUser: contact.isUser,
          name: contact.name,
          pushname: contact.pushname,
          elapsedMs: elapsed,
        },
      };
    }

    // Si getContactById falló pero isRegistered es true → fallback conservador
    if (contactError) {
      const classified = classifyWhatsAppError(contactError.message);

      if (classified) {
        log('CHECK', `❌ Error clasificado: ${classified}`);
        stats.failedChecks++;
        return {
          status: classified,
          message:
            classified === 'TEMPORARY_BAN' ? '⚠️ Solicitar revisión — baneo temporal' :
            classified === 'SPAM_BAN' ? '🚫 Ban por spam' :
            '❌ Cuenta suspendida',
          raw: { error: contactError.message, elapsedMs: elapsed },
        };
      }

      // No se pudo determinar → asumir ACTIVO pero marcar
      log('CHECK', `⚠️ getContactById falló, pero isRegistered=true → ACTIVO (con reserva)`);
      stats.successChecks++;
      return {
        status: 'ACTIVE',
        message: '✅ Número activo (verificación parcial)',
        raw: {
          isRegistered: true,
          contactError: contactError.message,
          elapsedMs: elapsed,
        },
      };
    }

    // No debería llegar aquí
    return {
      status: 'UNKNOWN',
      message: '❓ Estado desconocido',
      raw: { elapsedMs: elapsed },
    };

  } catch (e) {
    logError('CHECK', 'Error general', e);
    stats.failedChecks++;
    return {
      status: 'ERROR',
      message: `❌ Error: ${e.message}`,
      raw: { error: e.message, elapsedMs: Date.now() - start },
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
