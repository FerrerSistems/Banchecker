const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// CARGA Y ROTACIÓN DE PROXIES
// ══════════════════════════════════════════

let proxyList = [];
let currentProxyIndex = 0;

function loadProxies() {
  const filePath = path.join(__dirname, '..', 'proxy.txt');
  if (!fs.existsSync(filePath)) {
    log('WHATSAPP', '⚠️ proxy.txt no encontrado. Usando conexión directa.');
    return;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    
    proxyList = lines.map(line => {
      // Formato esperado: user:pass@ip:port
      const match = line.match(/^(?:(.+):(.+)@)?([^:]+):(\d+)$/);
      if (match) {
        return {
          username: match[1] || null,
          password: match[2] || null,
          ip: match[3],
          port: match[4],
        };
      }
      return null;
    }).filter(p => p !== null);
    
    log('WHATSAPP', `✅ Proxies cargados: ${proxyList.length}`);
  } catch (e) {
    logError('WHATSAPP', 'Error leyendo proxy.txt', e);
  }
}

function getNextProxy() {
  if (proxyList.length === 0) return null;
  const proxy = proxyList[currentProxyIndex % proxyList.length];
  currentProxyIndex++;
  log('WHATSAPP', `🔄 Rotando a proxy: ${proxy.ip}:${proxy.port}`);
  return proxy;
}

// ══════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════

let client = null;
let isReady = false;
let readyResolvers = [];
let currentQR = null;
let currentQRBuffer = null;
let isInitializing = false;
let initError = null;
let reconnectAttempts = 0;

let checkLock = Promise.resolve();

// ══════════════════════════════════════════
// LOGGING
// ══════════════════════════════════════════

function log(tag, msg, data) {
  const m = process.memoryUsage();
  const heap = (m.heapUsed / 1024 / 1024).toFixed(1);
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] [heap:${heap}MB] ${msg}${extra}`);
}

function logError(tag, msg, err) {
  const m = process.memoryUsage();
  const heap = (m.heapUsed / 1024 / 1024).toFixed(1);
  console.error(`[${new Date().toISOString()}] [${tag}] [heap:${heap}MB] ❌ ${msg}`);
  if (err) {
    if (err.name) console.error(`[${tag}]   name: ${err.name}`);
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.stack) err.stack.split('\n').slice(0, 5).forEach(l => console.error(`[${tag}]   ${l.trim()}`));
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
      reject(err);
    }, ms);

    promise.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timeoutId); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(timeoutId); reject(e); } }
    ).catch((e) => log('TIMEOUT', `Error tardío en "${label}": ${e.message}`));
  });
}

// ══════════════════════════════════════════
// SESIÓN
// ══════════════════════════════════════════

function hasSessionOnDisk() {
  try {
    const sessionDir = config.whatsapp.sessionPath;
    const sessionId = config.whatsapp.sessionId;
    const laDir = path.join(sessionDir, `session-${sessionId}`);
    if (!fs.existsSync(laDir)) return false;
    const defaultDir = path.join(laDir, 'Default');
    if (!fs.existsSync(defaultDir)) return false;
    return fs.existsSync(path.join(defaultDir, 'Local Storage')) || fs.existsSync(path.join(defaultDir, 'Preferences'));
  } catch (e) { return false; }
}

// ══════════════════════════════════════════
// CREAR CLIENTE CON PROXY
// ══════════════════════════════════════════

function createClient(clearSession = false) {
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
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {}
    }
  }

  // Obtener el siguiente proxy de la lista
  const proxy = getNextProxy();
  
  const args = [
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
    '--no-zygote'
  ];

  if (proxy) {
    args.push(`--proxy-server=http://${proxy.ip}:${proxy.port}`);
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.sessionId,
      dataPath: config.whatsapp.sessionPath,
    }),
    puppeteer: {
      executablePath: chromePath,
      headless: true,
      protocolTimeout: 180000,
      args,
    },
  });

  // ── Autenticación del proxy y captura del QR ──
  newClient.on('qr', async (qr) => {
    // Si hay proxy, autenticar en la página
    if (proxy && proxy.username && newClient.pupPage) {
      try {
        log('WHATSAPP', `🔐 Autenticando proxy ${proxy.ip}...`);
        await newClient.pupPage.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
        log('WHATSAPP', '✅ Proxy autenticado');
        // Recargar para que la autenticación tome efecto en los recursos
        // await newClient.pupPage.reload();
      } catch (e) {
        logError('WHATSAPP', 'Error autenticando proxy', e);
      }
    }

    currentQR = qr;
    try {
      const QRCode = require('qrcode');
      currentQRBuffer = await QRCode.toBuffer(qr, { type: 'png', width: 600, margin: 2 });
    } catch (e) {}
  });

  newClient.on('authenticated', () => {
    log('WHATSAPP', '✅ AUTENTICADO');
  });

  newClient.on('ready', () => {
    isReady = true;
    isInitializing = false;
    reconnectAttempts = 0;
    const info = newClient.info;
    emitter.emit('ready', info);
    readyResolvers.forEach(r => r(newClient));
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    isReady = false;
    isInitializing = false;
    client = null;
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR
// ══════════════════════════════════════════

async function initializeWhatsApp(clearSession = false) {
  if (client && isReady && !clearSession) return client;
  if (isInitializing) return new Promise((resolve) => readyResolvers.push(() => resolve(client)));

  // Asegurarse de tener los proxies cargados
  if (proxyList.length === 0) {
    loadProxies();
  }

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
      reject(new Error('Timeout init'));
    }, 300000);

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

async function reconnect() {
  reconnectAttempts++;
  return await initializeWhatsApp(false);
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

async function getReadyClient() {
  if (client && isReady) return client;
  if (!client || !isInitializing) return initializeWhatsApp(false);
  return new Promise((resolve) => readyResolvers.push(() => resolve(client)));
}

// ══════════════════════════════════════════
// CHECK STATUS (4-Factor simplificado)
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const release = await acquireLock();
  try {
    if (!isReady || !client) {
      setImmediate(() => reconnect().catch(e => {}));
      return { status: 'NOT_CONNECTED', message: '🔄 WhatsApp reconectando...', raw: {} };
    }

    const c = client;
    const jid = `${phone}@c.us`;

    let numberId = null;
    try {
      numberId = await withTimeout(c.getNumberId(phone), 10000, 'getNumberId');
    } catch (e) {}
    
    if (numberId === null) {
      return { status: 'PERMANENT_BAN', message: '❌ No está registrado en WhatsApp', raw: {} };
    }

    let deviceCount = null;
    try {
      deviceCount = await withTimeout(c.getContactDeviceCount(numberId._serialized), 15000, 'getContactDeviceCount');
    } catch (e) {}

    let contact = null;
    try {
      contact = await withTimeout(c.getContactById(jid), 12000, 'getContactById');
    } catch (e) {}

    if (contact) {
      if (contact.isWAContact === false) {
        return { status: 'PERMANENT_BAN', message: '❌ Cuenta suspendida', raw: { deviceCount } };
      }
      if (!contact.name && !contact.pushname && contact.isUser === false) {
        return { status: 'PERMANENT_BAN', message: '❌ Cuenta suspendida (perfil inactivo)', raw: { deviceCount } };
      }
      return { status: 'ACTIVE', message: `✅ Número activo`, raw: { deviceCount, name: contact.name } };
    }

    if (deviceCount === 0) {
        return { status: 'UNKNOWN', message: '❓ No se pudo confirmar', raw: { deviceCount } };
    }

    return { status: 'ACTIVE', message: '✅ Número activo (parcial)', raw: { deviceCount } };
  } catch (e) {
    return { status: 'ERROR', message: `❌ Error: ${e.message}`, raw: {} };
  } finally {
    release();
  }
}

function acquireLock() {
  let release;
  const next = new Promise((resolve) => { release = resolve; });
  const current = checkLock;
  checkLock = checkLock.then(() => next);
  return current.then(() => release);
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
  initializeWhatsApp,
  reconnect,
  restartForQR,
  getReadyClient,
  checkNumberStatus,
  destroyClient,
  getClient: () => client,
  isReady: () => isReady,
  getQR: () => currentQR,
  getQRBuffer: () => currentQRBuffer,
  hasQR: () => !!currentQRBuffer,
  clearQR: () => { currentQR = null; currentQRBuffer = null; },
  getDiagnostics: () => ({ ready: isReady, hasSession: hasSessionOnDisk(), proxies: proxyList.length }),
  getStats: () => ({}),
  hasSession: () => hasSessionOnDisk(),
  isNumberBanned: async (phone) => {
    const r = await checkNumberStatus(phone);
    return r.status === 'PERMANENT_BAN';
  },
  emitter,
};
