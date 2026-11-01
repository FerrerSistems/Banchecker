const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { HttpsProxyAgent } = require('https-proxy-agent');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const emitter = new EventEmitter();
let isReady = false;

function log(tag, msg, data) {
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}${extra}`);
}

// ── PROXIES ──
let proxyList = [];
let currentProxyIndex = 0;
function loadProxies() {
  const filePath = path.join(__dirname, '..', 'proxy.txt');
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    proxyList = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(line => {
      const match = line.match(/^(?:(.+):(.+)@)?([^:]+):(\d+)$/);
      return match ? { username: match[1], password: match[2], ip: match[3], port: match[4] } : null;
    }).filter(p => p !== null);
    log('PROXY', `✅ Proxies cargados: ${proxyList.length}`);
  } catch (e) {}
}

function getNextProxyAgent() {
  if (proxyList.length === 0) return null;
  const proxy = proxyList[currentProxyIndex % proxyList.length];
  currentProxyIndex++;
  const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : '';
  log('PROXY', `🔄 Usando proxy [${currentProxyIndex}/${proxyList.length}]: ${proxy.ip}`);
  try { return new HttpsProxyAgent(`http://${auth}${proxy.ip}:${proxy.port}`); } catch (e) { return null; }
}

// ── VERIFICACIÓN ──
async function checkNumberStatus(phone) {
  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `PING PAIRING CODE: ${phone}`);
  
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length < 8) return { status: 'ERROR', message: 'Número inválido', raw: {} };

  const tempSessionPath = path.join(config.whatsapp.sessionPath, `temp_${cleanPhone}_${Date.now()}`);
  let tempSock = null;

  try {
    if (!fs.existsSync(tempSessionPath)) fs.mkdirSync(tempSessionPath, { recursive: true });
    const { state } = await useMultiFileAuthState(tempSessionPath);
    const proxyAgent = getNextProxyAgent();

    tempSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      connectTimeoutMs: 20000,
      agent: proxyAgent,
      logger: require('pino')({ level: 'silent' }),
    });

    // 🚨 BLOQUEO TOTAL DE QR 🚨
    tempSock.ev.on('connection.update', (update) => {
      if (update.qr) {
        log('CHECK', '⚠️ Baileys intentó generar un QR. Ignorado (no pedimos login).');
      }
    });

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('TIMEOUT_SOLICITUD')), 25000)
    );

    log('CHECK', `Solicitando Pairing Code a WhatsApp...`);
    const code = await Promise.race([
      tempSock.requestPairingCode(cleanPhone),
      timeoutPromise
    ]);

    log('CHECK', `✅ CÓDIGO GENERADO: ${code}`);

    try { tempSock.end(undefined); } catch (e) {}
    setTimeout(() => { try { fs.rmSync(tempSessionPath, { recursive: true, force: true }); } catch (e) {} }, 1000);

    return { status: 'ACTIVE', message: `✅ Activo (Código: ${code})`, raw: { code, method: 'pairing_code' } };

  } catch (error) {
    const errMsg = error.message || 'Error desconocido';
    log('CHECK', `❌ Error: ${errMsg}`);
    if (tempSock) { try { tempSock.end(undefined); } catch (e) {} }
    try { fs.rmSync(tempSessionPath, { recursive: true, force: true }); } catch (e) {}

    const lowerErr = errMsg.toLowerCase();
    let status = 'ERROR', message = `❌ Error: ${errMsg}`;

    if (lowerErr.includes('timeout')) message = '⏱️ Timeout: WhatsApp o el Proxy no respondieron.';
    else if (lowerErr.includes('forbidden') || lowerErr.includes('banned') || lowerErr.includes('403')) {
      status = 'PERMANENT_BAN'; message = '❌ Cuenta suspendida o baneada.';
    } else if (lowerErr.includes('not on whatsapp') || lowerErr.includes('404')) {
      status = 'PERMANENT_BAN'; message = '❌ No registrado en WhatsApp.';
    } else if (lowerErr.includes('rate') || lowerErr.includes('429')) {
      message = '⚠️ Rate Limit: Demasiadas peticiones.';
    } else if (lowerErr.includes('econnrefused') || lowerErr.includes('proxy')) {
      message = '🌐 Error de Proxy.';
    }

    return { status, message, raw: { error: errMsg } };
  }
}

async function initializeWhatsApp() { loadProxies(); isReady = true; return true; }
function isReadyFn() { return isReady; }
function getDiagnostics() { return { provider: 'baileys_ping', proxies: proxyList.length, ready: isReady }; }

module.exports = {
  initializeWhatsApp, checkNumberStatus, isReady: isReadyFn, getDiagnostics,
  getClient: () => null, getQR: () => null, getQRBuffer: () => null, hasQR: () => false,
  clearQR: () => {}, getStats: () => ({}), hasSession: () => false, destroyClient: async () => { isReady = false; },
  isNumberBanned: async (phone) => (await checkNumberStatus(phone)).status === 'PERMANENT_BAN',
  emitter,
};
