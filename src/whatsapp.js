/**
 * MÓDULO WHATSAPP — Adaptado a supunmd-bail
 * Usa @mr-supun-fernando/supunmd-bail para verificación de números
 * ⚠️ ADVERTENCIA: Este paquete tiene reportes de seguridad.
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

// ⚠️ Importación de la librería (bajo tu responsabilidad)
const { makeWASocket, useMultiFileAuthState } = require('@mr-supun-fernando/supunmd-bail');

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════

let sock = null;
let isReady = false;
let readyResolvers = [];
let currentQR = null;
let currentQRBuffer = null;
let isInitializing = false;
let initStartTime = null;
let initError = null;
let initAttempts = 0;
let reconnectAttempts = 0;
let lastDisconnectReason = null;
let sessionPhone = null;

let checkLock = Promise.resolve();

// ══════════════════════════════════════════
// STATS
// ══════════════════════════════════════════

const stats = {
  totalChecks: 0,
  successChecks: 0,
  failedChecks: 0,
  reconnects: 0,
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
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`TIMEOUT_${label}`);
      err.isTimeout = true;
      err.label = label;
      logError('TIMEOUT', `"${label}" TIMEOUT en ${ms}ms`);
      reject(err);
    }, ms);

    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timeoutId); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timeoutId); reject(e); } }
    ).catch((e) => log('TIMEOUT', `Error tardío en "${label}": ${e.message}`));
  });
}

// ══════════════════════════════════════════
// SESIÓN EN DISCO
// ══════════════════════════════════════════

function hasSessionOnDisk() {
  try {
    const sessionDir = config.whatsapp.sessionPath;
    return fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).length > 0;
  } catch (e) {
    return false;
  }
}

// ══════════════════════════════════════════
// CREAR CLIENTE (socket)
// ══════════════════════════════════════════

async function createClient(clearSession = false) {
  log('WHATSAPP', `═══ CREANDO CLIENTE (clearSession=${clearSession}) ═══`);

  const sessionPath = config.whatsapp.sessionPath;

  if (clearSession) {
    log('WHATSAPP', '🗑️ Limpiando sesión');
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      }
      fs.mkdirSync(sessionPath, { recursive: true });
    } catch (e) {
      logError('WHATSAPP', 'Error limpiando sesión', e);
    }
  }

  log('WHATSAPP', `📁 Sesión en disco: ${hasSessionOnDisk()}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const newSock = makeWASocket({
    auth: state,
    syncFullHistory: false,
    aiLabel: false,
    printQRInTerminal: false,
  });

  log('WHATSAPP', '✅ Socket creado');

  // ══════════════════════════════════════════
  // EVENTOS
  // ══════════════════════════════════════════

  newSock.ev.on('creds.update', saveCreds);

  newSock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('WHATSAPP', `📲 QR generado`);
      currentQR = qr;
      // Generar buffer PNG
      try {
        const QRCode = require('qrcode');
        QRCode.toBuffer(qr, {
          type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'M',
        }).then(buffer => {
          currentQRBuffer = buffer;
          log('WHATSAPP', `💾 QR buffer: ${(buffer.length / 1024).toFixed(1)}KB`);
        }).catch(e => logError('WHATSAPP', 'Error buffer QR', e));
      } catch (e) {
        logError('WHATSAPP', 'Error generando QR', e);
      }
      emitter.emit('qr', qr);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'unknown';
      logError('WHATSAPP', `Conexión cerrada: ${statusCode} — ${reason}`);
      isReady = false;
      lastDisconnectReason = reason;
      emitter.emit('disconnected', reason);

      // Reconectar si no fue logout
      if (statusCode !== 401 && statusCode !== 403) {
        log('WHATSAPP', '🔄 Programando reconexión...');
        setTimeout(() => reconnect().catch(e => logError('WHATSAPP', 'Reconnect', e)), 5000);
      }
    } else if (connection === 'open') {
      log('WHATSAPP', '═══════ ✅ CONECTADO ═══════');
      isReady = true;
      isInitializing = false;
      reconnectAttempts = 0;
      currentQR = null;
      currentQRBuffer = null;
      sessionPhone = newSock.user?.id?.split(':')[0]?.split('@')[0] || null;

      log('WHATSAPP', `Número: ${sessionPhone || 'desconocido'}`);
      emitter.emit('ready', { wid: { user: sessionPhone } });
      readyResolvers.forEach(r => r(newSock));
      readyResolvers = [];
    }
  });

  return newSock;
}

// ══════════════════════════════════════════
// INICIALIZAR
// ══════════════════════════════════════════

async function initializeWhatsApp(clearSession = false) {
  log('WHATSAPP', `═══ INICIALIZANDO (clearSession=${clearSession}) ═══`);

  if (sock && isReady && !clearSession) return sock;

  if (isInitializing) {
    return new Promise((resolve) => {
      readyResolvers.push(() => resolve(sock));
    });
  }

  initAttempts++;
  log('WHATSAPP', `Intento #${initAttempts}`);
  isInitializing = true;
  initStartTime = Date.now();
  initError = null;

  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
    isReady = false;
  }

  try {
    sock = await createClient(clearSession);
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
      resolve(sock);
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
  try {
    if (sock) { try { sock.end(); } catch (e) {} }
    sock = null;
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
  if (sock && isReady) return sock;
  if (!sock || !isInitializing) return initializeWhatsApp(false);
  return new Promise((resolve) => readyResolvers.push(() => resolve(sock)));
}

// ══════════════════════════════════════════
// CHECK NUMBER STATUS — Usa checkBanStatus
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const release = await acquireLock();
  const start = Date.now();
  stats.totalChecks++;

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `ready=${isReady}`);
  log('CHECK', '════════════════════════════════════════');

  try {
    if (!isReady || !sock) {
      setImmediate(() => reconnect().catch(e => {}));
      return {
        status: 'NOT_CONNECTED',
        message: '🔄 WhatsApp reconectando...\n\nEspera 1-2 min.',
        raw: { autoReconnect: true },
      };
    }

    // ══════════════════════════════════════════
    // Llamada a checkBanStatus de supunmd-bail
    // ══════════════════════════════════════════
    log('CHECK', `Llamando checkBanStatus(${phone})...`);

    const result = await withTimeout(
      sock.checkBanStatus(phone),
      20000,
      'checkBanStatus'
    );

    const elapsed = Date.now() - start;
    stats.avgCheckMs = stats.avgCheckMs === 0 ? elapsed : (stats.avgCheckMs + elapsed) / 2;

    log('CHECK', `✅ Resultado: ${JSON.stringify(result)}`);

    // ══════════════════════════════════════════
    // Mapear resultado al formato del bot
    // ══════════════════════════════════════════
    // status: 'ACTIVE' | 'PROFILE_HIDDEN' | 'LIKELY_ACTIVE' | 'BANNED' | 'OFF_WHATSAPP' | 'UNKNOWN'
    // emoji: '🟢' | '🟡' | '🔴' | '❓'
    // confidence: 0..1
    // deviceCount: number | null
    // registryExists: boolean | null

    switch (result.status) {
      case 'ACTIVE':
        stats.successChecks++;
        return {
          status: 'ACTIVE',
          message: `✅ Número activo${result.profileName ? ` — ${result.profileName}` : ''}`,
          raw: { ...result, elapsedMs: elapsed },
        };

      case 'LIKELY_ACTIVE':
        stats.successChecks++;
        return {
          status: 'ACTIVE',
          message: `✅ Número probablemente activo${result.profileName ? ` — ${result.profileName}` : ''}`,
          raw: { ...result, elapsedMs: elapsed },
        };

      case 'PROFILE_HIDDEN':
        stats.successChecks++;
        return {
          status: 'ACTIVE',
          message: '✅ Número activo (perfil oculto)',
          raw: { ...result, elapsedMs: elapsed },
        };

      case 'BANNED':
        stats.failedChecks++;
        return {
          status: 'PERMANENT_BAN',
          message: '❌ Cuenta suspendida o baneada',
          raw: { ...result, elapsedMs: elapsed },
        };

      case 'OFF_WHATSAPP':
        stats.failedChecks++;
        return {
          status: 'PERMANENT_BAN',
          message: '❌ No está registrado en WhatsApp',
          raw: { ...result, elapsedMs: elapsed },
        };

      case 'UNKNOWN':
      default:
        stats.failedChecks++;
        return {
          status: 'UNKNOWN',
          message: `❓ No se pudo determinar el estado (confianza: ${(result.confidence * 100).toFixed(0)}%)`,
          raw: { ...result, elapsedMs: elapsed },
        };
    }

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
  if (sock) {
    try { sock.end(); } catch (e) {}
    sock = null;
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
    hasClient: !!sock,
    lastDisconnectReason,
    sessionPhone,
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
  getClient: () => sock,
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
