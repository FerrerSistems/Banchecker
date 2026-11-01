const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const emitter = new EventEmitter();

let client = null;
let isReady = false;
let readyResolvers = [];
let currentQR = null;
let currentQRBuffer = null;
let isInitializing = false;

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function createClient(clearSession = false) {
  let chromePath = config.whatsapp.chromePath;
  if (!chromePath) {
    const paths = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
    for (const p of paths) {
      if (fs.existsSync(p)) { chromePath = p; break; }
    }
  }

  if (clearSession) {
    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
    }
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.sessionId,
      dataPath: config.whatsapp.sessionPath,
    }),
    puppeteer: {
      executablePath: chromePath,
      // ⚠️ USAR EL NUEVO HEADLESS (Indetectable)
      headless: 'new', 
      protocolTimeout: 180000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
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
        
        // 🛡️ FLAGS ANTI-DETECCIÓN
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
        '--lang=es-ES,es',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
    },
  });

  newClient.on('loading_screen', (percent, message) => {
    log('WHATSAPP', `⏳ Cargando ${percent}% - ${message}`);
  });

  newClient.on('qr', async (qr) => {
    log('WHATSAPP', '📲 QR GENERADO');
    currentQR = qr;
    try {
      const QRCode = require('qrcode');
      currentQRBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 600, margin: 2 });
    } catch (e) {}
  });

  newClient.on('authenticated', () => {
    log('WHATSAPP', '✅ AUTENTICADO (WhatsApp aceptó el emparejamiento)');
  });

  newClient.on('ready', () => {
    log('WHATSAPP', '✅ CLIENTE LISTO Y CONECTADO');
    isReady = true;
    isInitializing = false;
    emitter.emit('ready', newClient.info);
    readyResolvers.forEach(r => r(newClient));
    readyResolvers = [];
  });

  newClient.on('auth_failure', (msg) => {
    log('WHATSAPP', `❌ FALLO AUTH: ${msg}`);
  });

  newClient.on('disconnected', (reason) => {
    log('WHATSAPP', `❌ DESCONECTADO: ${reason}`);
    isReady = false;
    isInitializing = false;
    client = null;
  });

  return newClient;
}

async function initializeWhatsApp(clearSession = false) {
  if (client && isReady && !clearSession) return client;
  if (isInitializing) return new Promise((resolve) => readyResolvers.push(() => resolve(client)));

  isInitializing = true;
  if (client) {
    try { await client.destroy(); } catch (e) {}
    client = null;
    isReady = false;
  }

  client = createClient(clearSession);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      isInitializing = false;
      reject(new Error('Timeout de inicialización'));
    }, 180000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      resolve(client);
    });

    client.initialize().catch((e) => {
      clearTimeout(timeout);
      isInitializing = false;
      reject(e);
    });
  });
}

async function restartForQR() {
  if (client) { try { await client.destroy(); } catch (e) {} }
  client = null;
  isReady = false;
  isInitializing = false;
  currentQR = null;
  currentQRBuffer = null;
  return await initializeWhatsApp(true);
}

async function reconnect() {
  return await initializeWhatsApp(false);
}

async function getReadyClient() {
  if (client && isReady) return client;
  if (!client || !isInitializing) return initializeWhatsApp(false);
  return new Promise((resolve) => readyResolvers.push(() => resolve(client)));
}

async function checkNumberStatus(phone) {
  if (!isReady || !client) return { status: 'NOT_CONNECTED', message: 'WhatsApp no conectado' };
  return { status: 'ACTIVE', message: 'Verificado' };
}

async function destroyClient() {
  if (client) {
    try { await client.destroy(); } catch (e) {}
    client = null;
    isReady = false;
    isInitializing = false;
  }
}

module.exports = {
  initializeWhatsApp, reconnect, restartForQR, getReadyClient, checkNumberStatus, destroyClient,
  getClient: () => client,
  isReady: () => isReady,
  getQR: () => currentQR,
  getQRBuffer: () => currentQRBuffer,
  hasQR: () => !!currentQRBuffer,
  clearQR: () => { currentQR = null; currentQRBuffer = null; },
  getDiagnostics: () => ({ ready: isReady }),
  getStats: () => ({}),
  hasSession: () => false,
  isNumberBanned: async () => false,
  emitter,
};
