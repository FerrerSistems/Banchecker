/**
 * MÓDULO DE WHATSAPP — VERSIÓN DEBUG COMPLETA
 * Full prints en cada evento, función restartForQR()
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
// CREAR CLIENTE
// ══════════════════════════════════════════

function createClient() {
  console.log('\n[WHATSAPP] ═══ CREANDO CLIENTE ═══');

  let chromePath = config.whatsapp.chromePath;

  if (!chromePath) {
    console.log('[WHATSAPP] chromePath no configurado, buscando...');
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
      } catch (e) {
        console.log(`[WHATSAPP] Error verificando ${p}: ${e.message}`);
      }
    }
  } else {
    console.log(`[WHATSAPP] chromePath desde config: ${chromePath}`);
  }

  if (!chromePath) {
    console.error('[WHATSAPP] ❌ No se encontró Chrome');
    throw new Error('Chrome no encontrado');
  }

  try {
    const chromeExists = fs.existsSync(chromePath);
    console.log(`[WHATSAPP] ¿Chrome existe? ${chromeExists ? '✅' : '❌'} (${chromePath})`);
    if (!chromeExists) {
      throw new Error(`Chrome no existe en: ${chromePath}`);
    }
  } catch (e) {
    console.error('[WHATSAPP] Error verificando Chrome:', e.message);
    throw e;
  }

  console.log(`[WHATSAPP] Session path: ${config.whatsapp.sessionPath}`);
  console.log(`[WHATSAPP] Session ID: ${config.whatsapp.sessionId}`);

  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.sessionId,
      dataPath: config.whatsapp.sessionPath,
    }),
    puppeteer: {
      executablePath: chromePath,
      headless: true,
      dumpio: false,
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
  // EVENTOS (con full prints)
  // ══════════════════════════════════════════

  newClient.on('qr', (qr) => {
    setEvent('qr');
    console.log(`\n[WHATSAPP] 📲 QR RECIBIDO (length: ${qr.length})`);
    currentQR = qr;

    if (!qrDisplayed) {
      console.log('[WHATSAPP] Mostrando QR en terminal:\n');
      try {
        qrcode.generate(qr, { small: true });
      } catch (e) {
        console.log('[WHATSAPP] Error generando QR terminal:', e.message);
      }
      qrDisplayed = true;
    }

    console.log('[WHATSAPP] Emitiendo evento "qr" al emitter...');
    emitter.emit('qr', qr);
    console.log('[WHATSAPP] ✅ Evento "qr" emitido\n');
  });

  newClient.on('loading_screen', (percent, message) => {
    setEvent(`loading_screen:${percent}`);
    console.log(`[WHATSAPP] ⏳ Cargando ${percent}% — ${message}`);
  });

  newClient.on('change_state', (state) => {
    setEvent(`change_state:${state}`);
    console.log(`[WHATSAPP] 🔄 Estado cambió: ${state}`);
  });

  newClient.on('authenticated', () => {
    setEvent('authenticated');
    console.log('\n[WHATSAPP] ✅ AUTENTICADO — guardando sesión...');
    emitter.emit('authenticated');
  });

  newClient.on('auth_failure', (msg) => {
    setEvent('auth_failure');
    console.error(`\n[WHATSAPP] ❌ FALLO AUTH: ${msg}`);
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
    console.log(`[WHATSAPP] Nombre: ${info?.pushname}`);
    console.log(`[WHATSAPP] Platform: ${info?.platform}\n`);

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

  newClient.on('message', (msg) => {
    console.log(`[WHATSAPP] 📩 Mensaje de ${msg.from}: ${(msg.body || '').substring(0, 30)}`);
  });

  newClient.on('message_create', (msg) => {
    console.log(`[WHATSAPP] 📤 Mensaje creado: ${msg.to}`);
  });

  newClient.on('error', (err) => {
    setEvent('error');
    console.error('[WHATSAPP] ❌ EVENTO ERROR:', err.message);
    console.error(err.stack);
    initError = err.message;
  });

  // Capturar logs de puppeteer/console
  newClient.on('remote_session_saved', () => {
    setEvent('remote_session_saved');
    console.log('[WHATSAPP] 💾 Sesión remota guardada');
  });

  newClient.on('vote_update', (vote) => {
    console.log(`[WHATSAPP] 🗳️ Vote update: ${JSON.stringify(vote)}`);
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR WHATSAPP
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  console.log('\n[WHATSAPP] ═══ INICIALIZANDO WHATSAPP ═══');

  if (client && isReady) {
    console.log('[WHATSAPP] Ya está listo, retornando cliente');
    return client;
  }

  if (isInitializing) {
    console.log('[WHATSAPP] Ya se está inicializando, esperando...');
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
      console.error(`\n[WHATSAPP] ❌ TIMEOUT (5 min) — Último evento: ${lastEventName}`);
      console.error(`[WHATSAPP] initError: ${initError || 'ninguno'}`);
      isInitializing = false;
      reject(new Error(`Timeout. Último evento: ${lastEventName}`));
    }, 5 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      const elapsed = ((Date.now() - initStartTime) / 1000).toFixed(1);
      console.log(`[WHATSAPP] ✅ Inicialización completada en ${elapsed}s`);
      resolve(client);
    });

    console.log('[WHATSAPP] Llamando client.initialize()...');

    client.initialize()
      .then(() => {
        console.log('[WHATSAPP] client.initialize() resolvió OK');
      })
      .catch((e) => {
        console.error('[WHATSAPP] ❌ client.initialize() falló:', e.message);
        console.error(e.stack);
        clearTimeout(timeout);
        isInitializing = false;
        initError = e.message;
        reject(e);
      });
  });
}

// ══════════════════════════════════════════
// FORZAR REINICIO PARA QR
// ══════════════════════════════════════════

async function restartForQR() {
  console.log('\n[WHATSAPP] ═══ REINICIANDO PARA GENERAR QR ═══');

  try {
    // Destruir cliente actual si existe
    if (client) {
      console.log('[WHATSAPP] Destruyendo cliente actual...');
      try {
        await client.destroy();
        console.log('[WHATSAPP] Cliente destruido');
      } catch (e) {
        console.error('[WHATSAPP] Error destruyendo:', e.message);
      }
    }

    client = null;
    isReady = false;
    isInitializing = false;
    qrDisplayed = false;
    currentQR = null;
    initError = null;

    // Limpiar sesión local corrupta
    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      console.log(`[WHATSAPP] Limpiando ${sessionDir}...`);
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        console.log('[WHATSAPP] Sesión local limpiada');
      } catch (e) {
        console.error('[WHATSAPP] Error limpiando:', e.message);
      }
    }

    // Reinicializar
    console.log('[WHATSAPP] Reinicializando...');
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
// VERIFICAR ESTADO
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  console.log(`\n[CHECK] ═══ Verificando ${phone} ═══`);
  const c = await getReadyClient();
  const chatId = `${phone}@c.us`;

  try {
    console.log(`[CHECK] getContactById(${chatId})...`);
    const contact = await c.getContactById(chatId);
    console.log(`[CHECK] Contacto: isWAContact=${contact.isWAContact}, isUser=${contact.isUser}`);

    if (!contact.isWAContact) {
      console.log('[CHECK] ❌ No es contacto WhatsApp');
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Registrar nuevo — baneo permanente',
        raw: { isWAContact: false, isUser: contact.isUser },
      };
    }

    try {
      console.log(`[CHECK] getChatById(${chatId})...`);
      const chat = await c.getChatById(chatId);

      if (chat && chat.name) {
        console.log(`[CHECK] ✅ Activo: ${chat.name}`);
        return {
          status: 'ACTIVE',
          message: '✅ Número activo',
          raw: { name: chat.name, isWAContact: true },
        };
      }

      console.log('[CHECK] ⚠️ Sin nombre, marcando VERIFY');
      return {
        status: 'VERIFY',
        message: '🔄 Verificar estado',
        raw: { chatExists: true },
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
          message: '🚫 Ban por spam',
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

      return {
        status: 'UNKNOWN',
        message: `❓ Estado desconocido: ${chatError.message}`,
        raw: { error: chatError.message },
      };
    }
  } catch (e) {
    console.error(`[CHECK] Error general: ${e.message}`);
    return {
      status: 'ERROR',
      message: `❌ Error: ${e.message}`,
      raw: { error: e.message },
    };
  }
}

async function isNumberBanned(phone) {
  const result = await checkNumberStatus(phone);
  return result.status !== 'ACTIVE';
}

// ══════════════════════════════════════════
// DESTRUIR CLIENTE
// ══════════════════════════════════════════

async function destroyClient() {
  console.log('[WHATSAPP] Destruyendo cliente...');
  if (client) {
    try {
      await client.destroy();
      console.log('[WHATSAPP] Cliente destruido');
    } catch (e) {
      console.error('[WHATSAPP] Error al destruir:', e.message);
    }
    client = null;
    isReady = false;
    isInitializing = false;
  }
}

// ══════════════════════════════════════════
// DIAGNÓSTICO
// ══════════════════════════════════════════

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
