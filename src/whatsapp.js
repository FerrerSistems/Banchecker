/**
 * MÓDULO DE WHATSAPP
 * Cliente de whatsapp-web.js para verificar estados de números
 * Integrado con sistema de QR por imagen
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

// EventEmitter para comunicarse con index.js
const emitter = new EventEmitter();

// ══════════════════════════════════════════
// ESTADO GLOBAL DEL CLIENTE
// ══════════════════════════════════════════

let client = null;
let isReady = false;
let readyResolvers = [];
let qrDisplayed = false;
let currentQR = null;

// ══════════════════════════════════════════
// CREAR CLIENTE
// ══════════════════════════════════════════

function createClient() {
  let chromePath = config.whatsapp.chromePath;

  if (!chromePath) {
    const possiblePaths = [
      'C:\\Users\\WINDOWS\\.cache\\puppeteer\\chrome\\win64-146.0.7680.66\\chrome-win64\\chrome.exe',
      'C:\\Users\\WINDOWS\\.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        chromePath = p;
        dbg('WHATSAPP', `Chrome detectado: ${p}`);
        break;
      }
    }
  }

  if (!chromePath) {
    console.error('❌ No se encontró Chrome/Chromium.');
    console.error('   Instala Chrome o especifica CHROME_PATH en las variables.');
    process.exit(1);
  }

  dbg('WHATSAPP', `Usando Chrome: ${chromePath}`);

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

  // ══════════════════════════════════════════
  // EVENTOS DEL CLIENTE
  // ══════════════════════════════════════════

  newClient.on('qr', (qr) => {
    dbg('WHATSAPP', '📲 QR recibido');
    currentQR = qr;

    if (!qrDisplayed) {
      console.log('\n📲 QR recibido (también enviado por Telegram al admin)\n');
      qrcode.generate(qr, { small: true });
      qrDisplayed = true;
    }

    emitter.emit('qr', qr);
  });

  newClient.on('loading_screen', (percent, message) => {
    dbg('WHATSAPP', `Cargando ${percent}% — ${message}`);
  });

  newClient.on('authenticated', () => {
    dbg('WHATSAPP', '✅ Autenticado');
    console.log('\n✅ Autenticado — guardando sesión...');
    emitter.emit('authenticated');
  });

  newClient.on('auth_failure', (msg) => {
    console.error(`\n❌ Fallo de autenticación: ${msg}`);
    isReady = false;
    emitter.emit('auth_failure', msg);
  });

  newClient.on('ready', () => {
    dbg('WHATSAPP', '✅ Cliente listo');
    isReady = true;
    qrDisplayed = false;

    const info = newClient.info;
    console.log(`\n✅ WhatsApp conectado como: +${info?.wid?.user}`);
    console.log(`   Nombre: ${info?.pushname}`);

    emitter.emit('ready', info);

    readyResolvers.forEach(resolve => resolve());
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    dbg('WHATSAPP', `❌ Desconectado: ${reason}`);
    isReady = false;
    client = null;
    emitter.emit('disconnected', reason);
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR WHATSAPP
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  if (client && isReady) return client;

  client = createClient();

  dbg('WHATSAPP', 'Inicializando...');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout de inicialización (5 minutos)'));
    }, 5 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      resolve(client);
    });

    client.initialize().catch(e => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

// ══════════════════════════════════════════
// OBTENER CLIENTE LISTO
// ══════════════════════════════════════════

async function getReadyClient() {
  if (client && isReady) return client;

  if (!client) {
    return initializeWhatsApp();
  }

  return new Promise((resolve) => {
    readyResolvers.push(() => resolve(client));
  });
}

// ══════════════════════════════════════════
// VERIFICAR ESTADO DE UN NÚMERO
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const c = await getReadyClient();
  const chatId = `${phone}@c.us`;

  dbg('CHECK', `Verificando ${chatId}...`);

  try {
    const contact = await c.getContactById(chatId);

    if (!contact.isWAContact) {
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Registrar nuevo — baneo permanente',
        raw: {
          isWAContact: false,
          isUser: contact.isUser,
          isBusiness: contact.isBusiness,
          number: contact.number,
        },
      };
    }

    try {
      const chat = await c.getChatById(chatId);

      if (chat && chat.name) {
        return {
          status: 'ACTIVE',
          message: '✅ Número activo',
          raw: {
            name: chat.name,
            isWAContact: true,
            isUser: contact.isUser,
          },
        };
      }

      return {
        status: 'VERIFY',
        message: '🔄 Verificar estado',
        raw: {
          chatExists: true,
          isWAContact: true,
        },
      };
    } catch (chatError) {
      const errMsg = chatError.message.toLowerCase();

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

      return {
        status: 'UNKNOWN',
        message: `❓ Estado desconocido: ${chatError.message}`,
        raw: { error: chatError.message },
      };
    }
  } catch (e) {
    const errMsg = e.message.toLowerCase();

    if (errMsg.includes('not found') || errMsg.includes('invalid')) {
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Registrar nuevo — baneo permanente',
        raw: { error: e.message },
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
// VERIFICAR SI UN NÚMERO ESTÁ BANEADO
// ══════════════════════════════════════════

async function isNumberBanned(phone) {
  const result = await checkNumberStatus(phone);
  return result.status !== 'ACTIVE';
}

// ══════════════════════════════════════════
// DESTRUIR CLIENTE
// ══════════════════════════════════════════

async function destroyClient() {
  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      dbg('WHATSAPP', `Error al destruir: ${e.message}`);
    }
    client = null;
    isReady = false;
  }
}

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = {
  createClient,
  initializeWhatsApp,
  getReadyClient,
  checkNumberStatus,
  isNumberBanned,
  destroyClient,
  getClient: () => client,
  isReady: () => isReady,
  getQR: () => currentQR,
  emitter,
};
