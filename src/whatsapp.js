/**
 * MÓDULO DE WHATSAPP — VERSIÓN CORREGIDA
 * - Usa getNumberId() para verificar existencia (rápido)
 * - Timeout wrapper de 20s por operación (no cuelga 90s)
 * - Full debug
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// ESTADO GLOBAL
// ══════════════════════════════════════════

let client = null;
let isReady = false;
let readyResolvers = [];
let qrDisplayed = false;
let currentQR = null;
let isInitializing = false;
let lastEventName = 'none';
let lastEventTime = null;
let initStartTime = null;
let initError = null;
let initAttempts = 0;

function setEvent(name) {
  lastEventName = name;
  lastEventTime = new Date();
  console.log(`[WHATSAPP-EVENT] ${new Date().toISOString()} → ${name}`);
}

// ══════════════════════════════════════════
// TIMEOUT WRAPPER
// ══════════════════════════════════════════

/**
 * Envuelve una promesa con timeout propio (evita cuelgues de 90s)
 */
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
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ];

    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          chromePath = p;
          console.log(`[WHATSAPP] ✅ Chrome encontrado: ${p}`);
          break;
        }
      } catch (e) {}
    }
  } else {
    console.log(`[WHATSAPP] chromePath desde config: ${chromePath}`);
  }

  if (!chromePath) {
    throw new Error('Chrome no encontrado');
  }

  console.log(`[WHATSAPP] Session path: ${config.whatsapp.sessionPath}`);

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

  newClient.on('qr', (qr) => {
    setEvent('qr');
    console.log(`\n[WHATSAPP] 📲 QR RECIBIDO (length: ${qr.length})`);
    currentQR = qr;

    if (!qrDisplayed) {
      try { qrcode.generate(qr, { small: true }); } catch (e) {}
      qrDisplayed = true;
    }

    emitter.emit('qr', qr);
    console.log('[WHATSAPP] ✅ Evento "qr" emitido\n');
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
    qrDisplayed = false;

    const info = newClient.info;
    console.log(`[WHATSAPP] Número: +${info?.wid?.user}`);
    console.log(`[WHATSAPP] Nombre: ${info?.pushname}\n`);

    emitter.emit('ready', info);

    readyResolvers.forEach(resolve => resolve(newClient));
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    setEvent('disconnected');
    console.error(`\n[WHATSAPP] ❌ DESCONECTADO: ${reason}\n`);
    isReady = false;
    isInitializing = false;
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
      console.error(`\n[WHATSAPP] ❌ TIMEOUT — Último evento: ${lastEventName}`);
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
    qrDisplayed = false;
    currentQR = null;
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
// ⭐ VERIFICAR ESTADO DE UN NÚMERO (CORREGIDO)
// Usa getNumberId() — rápido y confiable
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

  try {
    // ══════════════════════════════════════════
    // PASO 1: ¿El número está registrado en WhatsApp?
    // getNumberId() es MUCHO más rápido que getContactById()
    // ══════════════════════════════════════════
    console.log(`[CHECK] getNumberId(${phone})...`);
    const numberId = await withTimeout(
      c.getNumberId(phone),
      20000,
      'getNumberId'
    );

    console.log(`[CHECK] Resultado getNumberId: ${numberId ? numberId._serialized : 'null'}`);

    if (!numberId) {
      console.log('[CHECK] ❌ Número NO registrado en WhatsApp');
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp (baneo permanente)',
        raw: { isRegistered: false },
      };
    }

    // ══════════════════════════════════════════
    // PASO 2: Obtener info del contacto (con timeout propio)
    // ══════════════════════════════════════════
    console.log(`[CHECK] getContactById(${numberId._serialized})...`);

    let contact;
    try {
      contact = await withTimeout(
        c.getContactById(numberId._serialized),
        20000,
        'getContactById'
      );
      console.log(`[CHECK] isWAContact: ${contact.isWAContact}, isUser: ${contact.isUser}`);
    } catch (e) {
      console.log(`[CHECK] ⚠️ getContactById falló: ${e.message}`);
      // Si falla pero getNumberId devolvió algo, el número existe
      return {
        status: 'VERIFY',
        message: '🔄 Número registrado (verificación parcial)',
        raw: { numberId: numberId._serialized, contactError: e.message },
      };
    }

    if (!contact.isWAContact) {
      console.log('[CHECK] ❌ isWAContact = false');
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No es contacto de WhatsApp (baneo permanente)',
        raw: { isWAContact: false, isUser: contact.isUser },
      };
    }

    // ══════════════════════════════════════════
    // PASO 3: Intentar obtener el chat para más info
    // ══════════════════════════════════════════
    console.log(`[CHECK] getChatById(${numberId._serialized})...`);

    try {
      const chat = await withTimeout(
        c.getChatById(numberId._serialized),
        15000,
        'getChatById'
      );

      if (chat && chat.name) {
        console.log(`[CHECK] ✅ ACTIVO — Nombre: ${chat.name}`);
        return {
          status: 'ACTIVE',
          message: '✅ Número activo',
          raw: {
            name: chat.name,
            numberId: numberId._serialized,
          },
        };
      }

      console.log('[CHECK] ⚠️ Sin nombre, marcando VERIFY');
      return {
        status: 'VERIFY',
        message: '🔄 Verificar estado',
        raw: { hasChat: true, numberId: numberId._serialized },
      };
    } catch (chatError) {
      const errMsg = (chatError.message || '').toLowerCase();
      console.error(`[CHECK] Error getChatById: ${chatError.message}`);

      if (errMsg.includes('request review') || errMsg.includes('review')) {
        return {
          status: 'TEMPORARY_BAN',
          message: '⚠️ Solicitar revisión — baneo temporal',
          raw: { error: chatError.message },
        };
      }

      if (errMsg.includes('ban spam') || errMsg.includes('spam')) {
        return {
          status: 'SPAM_BAN',
          message: '🚫 Ban por spam detectado',
          raw: { error: chatError.message },
        };
      }

      if (errMsg.includes('not registered') || errMsg.includes('invalid')) {
        return {
          status: 'PERMANENT_BAN',
          message: '❌ Registrar nuevo — baneo permanente',
          raw: { error: chatError.message },
        };
      }

      // Si el número está registrado (getNumberId lo confirmó), es ACTIVO aunque
      // no podamos obtener el nombre del chat
      return {
        status: 'ACTIVE',
        message: '✅ Número activo (verificado)',
        raw: { numberId: numberId._serialized, chatError: chatError.message },
      };
    }
  } catch (e) {
    console.error(`[CHECK] ❌ Error general: ${e.message}`);
    console.error(e.stack);

    // Si fue timeout en getNumberId
    if (e.message.includes('Timeout')) {
      return {
        status: 'ERROR',
        message: `⏱️ ${e.message}`,
        raw: { error: e.message, timedOut: true },
      };
    }

    return {
      status: 'ERROR',
      message: `❌ Error: ${e.message}`,
      raw: { error: e.message },
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
  }
}

function getDiagnostics() {
  return {
    ready: isReady,
    initializing: isInitializing,
    hasQR: !!currentQR,
    lastEvent: lastEventName,
    lastEventTime: lastEventTime?.toISOString() || null,
    initStartTime: initStartTime ? new Date(initStartTime).toISOString() : null,
    initElapsedSec: initStartTime ? ((Date.now() - initStartTime) / 1000).toFixed(1) : null,
    initError,
    initAttempts,
    hasClient: !!client,
  };
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
  getDiagnostics,
  emitter,
};
