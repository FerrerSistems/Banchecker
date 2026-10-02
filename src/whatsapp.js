/**
 * MÓDULO DE WHATSAPP — VERSIÓN FINAL
 * - NO emite eventos QR en cadena (evita spam)
 * - checkNumberStatus() con isRegisteredUser + fallbacks
 * - Timeouts de 15s por operación
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
let lastEventName = 'none';
let lastEventTime = null;
let initStartTime = null;
let initError = null;
let initAttempts = 0;
let fullySyncedAt = null; // Timestamp cuando el cliente terminó de sincronizar

function setEvent(name) {
  lastEventName = name;
  lastEventTime = new Date();
  console.log(`[WHATSAPP-EVENT] ${new Date().toISOString()} → ${name}`);
}

// ══════════════════════════════════════════
// TIMEOUT WRAPPER
// ══════════════════════════════════════════

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Timeout en ${label} (${ms}ms)`)), ms)
    ),
  ]);
}

// ══════════════════════════════════════════
// CREAR CLIENTE
// ══════════════════════════════════════════

function createClient() {
  console.log('\n[WHATSAPP] ═══ CREANDO CLIENTE ═══');

  let chromePath = config.whatsapp.chromePath;

  if (!chromePath) {
    const possiblePaths = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium',
    ];

    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          chromePath = p;
          console.log(`[WHATSAPP] ✅ Chrome: ${p}`);
          break;
        }
      } catch (e) {}
    }
  }

  if (!chromePath) throw new Error('Chrome no encontrado');

  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.sessionId,
      dataPath: config.whatsapp.sessionPath,
    }),
    puppeteer: {
      executablePath: chromePath,
      headless: true,
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

  console.log('[WHATSAPP] Cliente creado, registrando eventos...\n');

  // ══════════════════════════════════════════
  // EVENTOS
  // ══════════════════════════════════════════

  newClient.on('qr', async (qr) => {
    setEvent('qr');
    console.log(`\n[WHATSAPP] 📲 QR generado (length: ${qr.length})`);
    console.log('[WHATSAPP] ⚠️ NO se envía automáticamente. Usa /session');

    currentQR = qr;

    // Generar imagen y guardarla EN MEMORIA (no enviar)
    try {
      const QRCode = require('qrcode');
      currentQRBuffer = await QRCode.toBuffer(qr, {
        type: 'png',
        width: 600,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      console.log(`[WHATSAPP] 💾 QR guardado en memoria (${(currentQRBuffer.length / 1024).toFixed(1)} KB)\n`);
    } catch (e) {
      console.error('[WHATSAPP] ❌ Error generando buffer QR:', e.message);
      currentQRBuffer = null;
    }

    // NO emitir a index.js → evita spam
    // emitter.emit('qr', qr);  // ← QUITADO INTENCIONALMENTE
  });

  newClient.on('loading_screen', (percent, message) => {
    setEvent(`loading_screen:${percent}`);
    console.log(`[WHATSAPP] ⏳ Cargando ${percent}% — ${message}`);
  });

  newClient.on('change_state', (state) => {
    setEvent(`change_state:${state}`);
    console.log(`[WHATSAPP] 🔄 Estado: ${state}`);
  });

  newClient.on('authenticated', () => {
    setEvent('authenticated');
    console.log('\n[WHATSAPP] ✅ AUTENTICADO\n');
    emitter.emit('authenticated');
  });

  newClient.on('auth_failure', (msg) => {
    setEvent('auth_failure');
    console.error(`\n[WHATSAPP] ❌ FALLO AUTH: ${msg}\n`);
    isReady = false;
    initError = `Auth failure: ${msg}`;
    emitter.emit('auth_failure', msg);
  });

  newClient.on('ready', () => {
    setEvent('ready');
    console.log('\n[WHATSAPP] ✅✅✅ CLIENTE LISTO ✅✅✅');
    isReady = true;
    isInitializing = false;

    const info = newClient.info;
    console.log(`[WHATSAPP] Número: +${info?.wid?.user}`);
    console.log(`[WHATSAPP] Nombre: ${info?.pushname}`);

    // Marcar sync time (esperar 20s antes de aceptar queries)
    fullySyncedAt = null;
    setTimeout(() => {
      fullySyncedAt = Date.now();
      console.log('[WHATSAPP] 🔄 Cliente completamente sincronizado\n');
    }, 20000);

    emitter.emit('ready', info);

    readyResolvers.forEach(resolve => resolve(newClient));
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    setEvent('disconnected');
    console.error(`\n[WHATSAPP] ❌ DESCONECTADO: ${reason}\n`);
    isReady = false;
    isInitializing = false;
    fullySyncedAt = null;
    client = null;
    emitter.emit('disconnected', reason);
  });

  newClient.on('error', (err) => {
    setEvent('error');
    console.error('[WHATSAPP] ❌ EVENTO ERROR:', err.message);
    initError = err.message;
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  console.log('\n[WHATSAPP] ═══ INICIALIZANDO ═══');

  if (client && isReady) return client;

  if (isInitializing) {
    return new Promise((resolve) => {
      readyResolvers.push(() => resolve(client));
    });
  }

  initAttempts++;
  console.log(`[WHATSAPP] Intento #${initAttempts}`);
  isInitializing = true;
  initStartTime = Date.now();
  initError = null;

  try {
    client = createClient();
  } catch (e) {
    console.error('[WHATSAPP] ❌ Error creando cliente:', e.message);
    isInitializing = false;
    initError = e.message;
    throw e;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error(`\n[WHATSAPP] ❌ TIMEOUT — Evento: ${lastEventName}`);
      isInitializing = false;
      reject(new Error(`Timeout. Evento: ${lastEventName}`));
    }, 5 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      resolve(client);
    });

    client.initialize()
      .then(() => console.log('[WHATSAPP] client.initialize() OK'))
      .catch((e) => {
        console.error('[WHATSAPP] ❌ initialize() falló:', e.message);
        clearTimeout(timeout);
        isInitializing = false;
        initError = e.message;
        reject(e);
      });
  });
}

// ══════════════════════════════════════════
// RESTART PARA QR
// ══════════════════════════════════════════

async function restartForQR() {
  console.log('\n[WHATSAPP] ═══ REINICIANDO PARA QR ═══');

  try {
    if (client) {
      try { await client.destroy(); } catch (e) {}
    }

    client = null;
    isReady = false;
    isInitializing = false;
    currentQR = null;
    currentQRBuffer = null;
    fullySyncedAt = null;
    initError = null;

    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        console.log('[WHATSAPP] Sesión local limpiada');
      } catch (e) {}
    }

    return await initializeWhatsApp();
  } catch (e) {
    console.error('[WHATSAPP] ❌ Error en restartForQR:', e.message);
    throw e;
  }
}

// ══════════════════════════════════════════
// OBTENER CLIENTE LISTO
// ══════════════════════════════════════════

async function getReadyClient() {
  if (client && isReady) return client;

  if (!client || !isInitializing) {
    return initializeWhatsApp();
  }

  return new Promise((resolve) => {
    readyResolvers.push(() => resolve(client));
  });
}

// ══════════════════════════════════════════
// VERIFICAR ESTADO (SIMPLIFICADO Y ROBUSTO)
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  console.log(`\n[CHECK] ═══ Verificando ${phone} ═══`);

  const c = await getReadyClient();

  if (!c || !isReady) {
    return {
      status: 'ERROR',
      message: '❌ WhatsApp no está listo',
      raw: { error: 'client_not_ready' },
    };
  }

  const chatId = `${phone}@c.us`;

  // ══════════════════════════════════════════
  // PASO 1: ¿Está registrado en WhatsApp?
  // Usamos isRegisteredUser (rápido) con fallback a getNumberId
  // ══════════════════════════════════════════
  let isRegistered = false;
  let method = 'none';

  // Intento 1: isRegisteredUser
  try {
    console.log(`[CHECK] isRegisteredUser(${chatId})...`);
    isRegistered = await withTimeout(
      c.isRegisteredUser(chatId),
      15000,
      'isRegisteredUser'
    );
    method = 'isRegisteredUser';
    console.log(`[CHECK] isRegisteredUser → ${isRegistered}`);
  } catch (e) {
    console.log(`[CHECK] ⚠️ isRegisteredUser falló: ${e.message}`);

    // Intento 2: getNumberId
    try {
      console.log(`[CHECK] getNumberId(${phone})...`);
      const numberId = await withTimeout(
        c.getNumberId(phone),
        15000,
        'getNumberId'
      );
      isRegistered = !!numberId;
      method = 'getNumberId';
      console.log(`[CHECK] getNumberId → ${isRegistered ? numberId._serialized : 'null'}`);
    } catch (e2) {
      console.log(`[CHECK] ⚠️ getNumberId también falló: ${e2.message}`);

      // Ambos fallaron → probablemente timeout de WhatsApp
      return {
        status: 'ERROR',
        message: `⏱️ Timeout verificando. WhatsApp no responde.`,
        raw: { isRegisteredError: e2.message, firstError: e.message },
      };
    }
  }

  // Si no está registrado → PERMANENT_BAN
  if (!isRegistered) {
    console.log(`[CHECK] ❌ No registrado (método: ${method})`);
    return {
      status: 'PERMANENT_BAN',
      message: '❌ No está registrado en WhatsApp (baneo permanente o número inexistente)',
      raw: { isRegistered: false, method },
    };
  }

  // ══════════════════════════════════════════
  // PASO 2: Está registrado → obtener contacto con timeout corto
  // ══════════════════════════════════════════
  try {
    console.log(`[CHECK] getContactById(${chatId})...`);
    const contact = await withTimeout(
      c.getContactById(chatId),
      15000,
      'getContactById'
    );

    console.log(`[CHECK] isWAContact: ${contact.isWAContact}`);

    if (!contact.isWAContact) {
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No es contacto de WhatsApp',
        raw: { isWAContact: false },
      };
    }

    // Éxito
    const name = contact.name || contact.pushname || null;
    console.log(`[CHECK] ✅ ACTIVO — ${name || 'sin nombre'}`);

    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: {
        name,
        isWAContact: true,
        method,
      },
    };
  } catch (e) {
    // Si el contacto falla PERO el número está registrado, asumimos ACTIVE
    console.log(`[CHECK] ⚠️ getContactById falló: ${e.message}`);
    console.log('[CHECK] Número registrado → marcando como ACTIVO');

    return {
      status: 'ACTIVE',
      message: '✅ Número activo (verificado por registro)',
      raw: {
        method,
        contactError: e.message,
        note: 'isRegisteredUser confirmó que existe',
      },
    };
  }
}

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

async function isNumberBanned(phone) {
  const result = await checkNumberStatus(phone);
  return result.status !== 'ACTIVE' && result.status !== 'VERIFY';
}

async function destroyClient() {
  console.log('[WHATSAPP] Destruyendo cliente...');
  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      console.error('[WHATSAPP] Error al destruir:', e.message);
    }
    client = null;
    isReady = false;
    isInitializing = false;
    fullySyncedAt = null;
  }
}

function getDiagnostics() {
  return {
    ready: isReady,
    initializing: isInitializing,
    hasQR: !!currentQRBuffer,
    lastEvent: lastEventName,
    lastEventTime: lastEventTime?.toISOString() || null,
    initStartTime: initStartTime ? new Date(initStartTime).toISOString() : null,
    initElapsedSec: initStartTime ? ((Date.now() - initStartTime) / 1000).toFixed(1) : null,
    initError,
    initAttempts,
    hasClient: !!client,
    fullySynced: !!fullySyncedAt,
  };
}

function getQRBuffer() {
  return currentQRBuffer;
}

function hasQR() {
  return !!currentQRBuffer;
}

function clearQR() {
  currentQR = null;
  currentQRBuffer = null;
  console.log('[WHATSAPP] QR limpiado');
}

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
  emitter,
};
