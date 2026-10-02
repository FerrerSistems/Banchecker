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
    process.exit(1);
  }

  const client = new Client({
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

  client.on('qr', (qr) => {
    dbg('WHATSAPP', '📲 QR recibido');
    currentQR = qr;

    // Mostrar en terminal (por si alguien mira los logs)
    if (!qrDisplayed) {
      console.log('\n📲 QR recibido (también enviado por Telegram al admin)\n');
      qrcode.generate(qr, { small: true });
      qrDisplayed = true;
    }

    // Emitir evento para que index.js lo envíe por Telegram
    emitter.emit('qr', qr);
  });

  client.on('loading_screen', (percent, message) => {
    dbg('WHATSAPP', `Cargando ${percent}% — ${message}`);
  });

  client.on('authenticated', () => {
    dbg('WHATSAPP', '✅ Autenticado');
    console.log('\n✅ Autenticado — guardando sesión...');
    emitter.emit('authenticated');
  });

  client.on('auth_failure', (msg) => {
    console.error(`\n❌ Fallo de autenticación: ${msg}`);
    isReady = false;
    emitter.emit('auth_failure', msg);
  });

  client.on('ready', () => {
    dbg('WHATSAPP', '✅ Cliente listo');
    isReady = true;
    qrDisplayed = false;

    const info = client.info;
    console.log(`\n✅ WhatsApp conectado como: +${info?.wid?.user}`);
    console.log(`   Nombre: ${info?.pushname}`);

    emitter.emit('ready', info);

    readyResolvers.forEach(resolve => resolve());
    readyResolvers = [];
  });

  client.on('disconnected', (reason) => {
    dbg('WHATSAPP', `❌ Desconectado: ${reason}`);
    isReady = false;
    client = null;
    emitter.emit('disconnected', reason);
  });

  return client;
}

// ... el resto del archivo (initializeWhatsApp, getReadyClient, checkNumberStatus, isNumberBanned, destroyClient) queda EXACTAMENTE IGUAL ...

// ══════════════════════════════════════════
// EXPORTAR (actualizado con emitter)
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
  emitter, // ← NUEVO
};
