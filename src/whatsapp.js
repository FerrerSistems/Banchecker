const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const emitter = new EventEmitter();

let sock = null;
let isReady = false;
let readyResolvers = [];
let currentQR = null;
let currentQRBuffer = null;
let isInitializing = false;

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

async function createClient(clearSession = false) {
  log('WHATSAPP', '=== CREANDO CLIENTE BAILEYS (Sin Chrome) ===');
  const sessionPath = config.whatsapp.sessionPath;

  if (clearSession) {
    if (fs.existsSync(sessionPath)) {
      try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
    }
  }
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const { version } = await fetchLatestBaileysVersion();

  const newSock = makeWASocket({
    version,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  newSock.ev.on('creds.update', saveCreds);

  newSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log('WHATSAPP', '📲 QR GENERADO (Baileys)');
      currentQR = qr;
      try {
        const QRCode = require('qrcode');
        currentQRBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 600, margin: 2 });
      } catch (e) {}
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      log('WHATSAPP', `❌ Desconectado (${statusCode})`);
      isReady = false;
      sock = null;
      
      if (statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => reconnect(), 5000);
      }
    } else if (connection === 'open') {
      log('WHATSAPP', '✅ CLIENTE LISTO Y CONECTADO');
      isReady = true;
      isInitializing = false;
      emitter.emit('ready', newSock.user);
      readyResolvers.forEach(r => r(newSock));
      readyResolvers = [];
    }
  });

  return newSock;
}

async function initializeWhatsApp(clearSession = false) {
  if (sock && isReady && !clearSession) return sock;
  if (isInitializing) return new Promise((resolve) => readyResolvers.push(() => resolve(sock)));

  isInitializing = true;
  if (sock) { try { sock.end(undefined); } catch (e) {} sock = null; isReady = false; }

  sock = await createClient(clearSession);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      isInitializing = false;
      reject(new Error('Timeout de inicialización'));
    }, 180000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      resolve(sock);
    });
  });
}

async function restartForQR() {
  if (sock) { try { sock.end(undefined); } catch (e) {} }
  sock = null; isReady = false; isInitializing = false; currentQR = null; currentQRBuffer = null;
  return await initializeWhatsApp(true);
}

async function reconnect() {
  return await initializeWhatsApp(false);
}

async function getReadyClient() {
  if (sock && isReady) return sock;
  if (!sock || !isInitializing) return initializeWhatsApp(false);
  return new Promise((resolve) => readyResolvers.push(() => resolve(sock)));
}

// ══════════════════════════════════════════
// VERIFICACIÓN DE BAN USANDO JIDS
// ══════════════════════════════════════════
async function checkNumberStatus(phone) {
  if (!isReady || !sock) return { status: 'NOT_CONNECTED', message: 'WhatsApp no conectado' };
  
  try {
    const jid = `${phone}@s.whatsapp.net`;
    
    // 1. Verificar si el número existe en los servidores de WhatsApp
    const [result] = await sock.onWhatsApp(jid);
    
    if (!result || !result.exists) {
      return { status: 'PERMANENT_BAN', message: '❌ No registrado en WhatsApp' };
    }

    // 2. Intentar extraer metadata para ver si está suspendido
    try {
      // Si el número está suspendido, devuelve error o no devuelve perfil
      const profile = await sock.fetchStatus(jid);
      
      // Si la petición va bien, está activo
      return { status: 'ACTIVE', message: '✅ Número activo' };
    } catch (e) {
      const errMsg = (e.message || '').toLowerCase();
      if (errMsg.includes('forbidden') || errMsg.includes('banned') || errMsg.includes('401')) {
        return { status: 'PERMANENT_BAN', message: '❌ Cuenta suspendida' };
      }
      return { status: 'ACTIVE', message: '✅ Número activo (verificación parcial)' };
    }
  } catch (e) {
    return { status: 'ERROR', message: `❌ Error: ${e.message}` };
  }
}

async function destroyClient() {
  if (sock) {
    try { sock.end(undefined); } catch (e) {}
    sock = null; isReady = false; isInitializing = false;
  }
}

module.exports = {
  initializeWhatsApp, reconnect, restartForQR, getReadyClient, checkNumberStatus, destroyClient,
  getClient: () => sock,
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
