/**
 * MÓDULO WHATSAPP — v12 (4-Factor Ban Checker)
 * Usa whatsapp-web.js con detección de baneo en cascada
 * Combina getNumberId, getContactDeviceCount y getContactById
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
      protocolTimeout: 180000, // 3 minutos para evitar cuelgues largos
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
        '--single-process',
        '--no-zygote',
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
// CHECK NUMBER STATUS — 4-Factor Ban Checker
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const release = await acquireLock();
  const start = Date.now();
  stats.totalChecks++;

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `ready=${isReady} | healthy=${await healthCheckPage()}`);
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
        message: `⏳ WhatsApp inicializando (${elapsed}s)...\n\nEspera 1-2 min.`,
        raw: { initializing: true },
      };
    }

    const c = client;

    // ══════════════════════════════════════════
    // FACTOR 1: Health check de la página
    // ══════════════════════════════════════════
    const healthy1 = await healthCheckPage();
    if (!healthy1) {
      setImmediate(() => reconnect().catch(e => {}));
      return {
        status: 'ERROR',
        message: '⚠️ WhatsApp reconectando. Intenta en 1-2 min.',
        raw: { reason: 'page_unhealthy' },
      };
    }
    log('CHECK', '✅ Factor 1: Página OK');

    // ══════════════════════════════════════════
    // FACTOR 2: getNumberId (Existencia del número)
    // ══════════════════════════════════════════
    log('CHECK', `🔍 Factor 2: getNumberId(${phone})...`);
    let numberId = null;
    let getNumberIdError = null;

    try {
      const t0 = Date.now();
      numberId = await withTimeout(c.getNumberId(phone), 10000, 'getNumberId');
      log('CHECK', `✅ Factor 2: getNumberId → ${numberId ? numberId._serialized : 'null'} (${Date.now() - t0}ms)`);
    } catch (e) {
      getNumberIdError = e;
      logError('CHECK', 'getNumberId falló', e);
      if (isPageBroken(e)) {
        setImmediate(() => reconnect().catch(e => {}));
        return { status: 'ERROR', message: '⚠️ WhatsApp reconectando.', raw: { reason: 'page_broken' } };
      }
    }

    // Si getNumberId devolvió null explícitamente → NO EXISTE
    if (numberId === null && !getNumberIdError) {
      log('CHECK', `❌ Factor 2: getNumberId=null → NO REGISTRADO`);
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isRegistered: false, elapsedMs: Date.now() - start },
      };
    }

    // Si getNumberId falló con timeout → No concluyente
    if (getNumberIdError) {
      const healthy2 = await healthCheckPage();
      if (!healthy2) {
        setImmediate(() => reconnect().catch(e => {}));
        return { status: 'ERROR', message: '⚠️ WhatsApp reconectando.', raw: { reason: 'page_unhealthy_after_timeout' } };
      }
      stats.failedChecks++;
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Cuenta suspendida (getNumberId no responde)',
        raw: { reason: 'getNumberId_timeout', elapsedMs: Date.now() - start },
      };
    }

    // ══════════════════════════════════════════
    // FACTOR 3: getContactDeviceCount (Firma de dispositivos)
    // ══════════════════════════════════════════
    const targetId = numberId._serialized;
    log('CHECK', `🔍 Factor 3: getContactDeviceCount(${targetId})...`);

    let deviceCount = null;
    let deviceCountError = null;

    try {
      const t0 = Date.now();
      deviceCount = await withTimeout(
        c.getContactDeviceCount(targetId),
        15000,
        'getContactDeviceCount'
      );
      log('CHECK', `✅ Factor 3: getContactDeviceCount → ${deviceCount} dispositivos (${Date.now() - t0}ms)`);
    } catch (e) {
      deviceCountError = e;
      logError('CHECK', 'getContactDeviceCount falló', e);
      if (isPageBroken(e)) {
        setImmediate(() => reconnect().catch(e => {}));
        return { status: 'ERROR', message: '⚠️ WhatsApp reconectando.', raw: { reason: 'page_broken' } };
      }
    }

    // ══════════════════════════════════════════
    // FACTOR 4: getContactById (Metadatos del contacto)
    // ══════════════════════════════════════════
    const chatId = `${phone}@c.us`;
    log('CHECK', `🔍 Factor 4: getContactById(${chatId})...`);

    let contact = null;
    let contactError = null;

    try {
      const t0 = Date.now();
      contact = await withTimeout(c.getContactById(chatId), 12000, 'getContactById');
      log('CHECK', `✅ Factor 4: getContactById OK (${Date.now() - t0}ms)`);
      log('CHECK', `   isWAContact: ${contact.isWAContact}, isUser: ${contact.isUser}, name: ${contact.name || '(vacío)'}`);
    } catch (e) {
      contactError = e;
      logError('CHECK', 'getContactById falló', e);
      if (isPageBroken(e)) {
        setImmediate(() => reconnect().catch(e => {}));
        return { status: 'ERROR', message: '⚠️ WhatsApp reconectando.', raw: { reason: 'page_broken' } };
      }
    }

    const elapsed = Date.now() - start;
    stats.avgCheckMs = stats.avgCheckMs === 0 ? elapsed : (stats.avgCheckMs + elapsed) / 2;

    // ══════════════════════════════════════════
    // ANÁLISIS COMBINADO (Lógica del 4-Factor)
    // ══════════════════════════════════════════

    // --- CASO A: Tenemos contacto y su metadata es clara ---
    if (contact) {
      // Señal de baneo más fiable: la cuenta no es un contacto de WhatsApp
      if (contact.isWAContact === false) {
        log('CHECK', `❌ ANÁLISIS: isWAContact=false → BANEADO`);
        stats.failedChecks++;
        return {
          status: 'PERMANENT_BAN',
          message: '❌ Cuenta suspendida o baneada (no es contacto activo)',
          raw: { isWAContact: false, deviceCount, elapsedMs: elapsed },
        };
      }

      // Señal secundaria: sin nombre público y no es un usuario (perfil vacío)
      if (!contact.name && !contact.pushname && contact.isUser === false) {
        log('CHECK', `❌ ANÁLISIS: Perfil vacío y isUser=false → BANEADO`);
        stats.failedChecks++;
        return {
          status: 'PERMANENT_BAN',
          message: '❌ Cuenta suspendida (perfil inactivo)',
          raw: { isUser: false, deviceCount, elapsedMs: elapsed },
        };
      }

      // Si tiene nombre o es un usuario, y la firma de dispositivos es la esperada, está activo
      if ((contact.name || contact.pushname || contact.isUser) && deviceCount && deviceCount >= 2) {
        const name = contact.name || contact.pushname || 'Sin nombre';
        log('CHECK', `✅ ANÁLISIS: Nombre presente y ${deviceCount} dispositivos → ACTIVO ("${name}")`);
        stats.successChecks++;
        return {
          status: 'ACTIVE',
          message: `✅ Número activo (${deviceCount} dispositivos)`,
          raw: { name, deviceCount, isWAContact: contact.isWAContact, elapsedMs: elapsed },
        };
      }

      // Si la firma de dispositivos es 0 pero el perfil parece normal, podría ser un número nuevo o con datos incompletos.
      if (deviceCount === 0 && (contact.name || contact.pushname || contact.isUser)) {
        log('CHECK', `⚠️ ANÁLISIS: 0 dispositivos pero perfil normal → SOSPECHOSO`);
        stats.failedChecks++;
        return {
          status: 'UNKNOWN',
          message: '❓ Número existe pero no se pudo confirmar su estado (perfil normal, 0 dispositivos)',
          raw: { deviceCount, isWAContact: contact.isWAContact, elapsedMs: elapsed },
        };
      }
    }

    // --- CASO B: getContactById falló pero tenemos el número ---
    if (contactError) {
      const classified = classifyWhatsAppError(contactError.message);
      if (classified) {
        stats.failedChecks++;
        return {
          status: classified,
          message: classified === 'TEMPORARY_BAN' ? '⚠️ Baneo temporal' : '❌ Cuenta suspendida',
          raw: { error: contactError.message, deviceCount, elapsedMs: elapsed },
        };
      }
      // Error desconocido
      return {
        status: 'UNKNOWN',
        message: '❓ Número existe pero no se pudo verificar el estado (error al obtener contacto).',
        raw: { numberId: targetId, deviceCount, elapsedMs: elapsed },
      };
    }

    // --- CASO C: No se obtuvo contacto ni error, pero el número existe ---
    // Esta es la situación que causaba los falsos positivos. Ahora, si la firma de dispositivos es 0, NO es un baneo concluyente.
    if (deviceCount === 0) {
      log('CHECK', `⚠️ ANÁLISIS: Número existe, sin contacto, 0 dispositivos → NO CONCLUYENTE`);
      stats.failedChecks++;
      return {
        status: 'UNKNOWN',
        message: '❓ Número existe pero su estado no es claro (datos de contacto no disponibles).',
        raw: { numberId: targetId, deviceCount, elapsedMs: elapsed },
      };
    }

    // Si llegamos aquí, el número existe y tiene dispositivos pero no pudimos obtener el contacto.
    if (deviceCount >= 2) {
      log('CHECK', `✅ ANÁLISIS: Número existe y tiene ${deviceCount} dispositivos (sin contacto) → ACTIVO`);
      stats.successChecks++;
      return {
        status: 'ACTIVE',
        message: `✅ Número activo (${deviceCount} dispositivos)`,
        raw: { deviceCount, elapsedMs: elapsed },
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
