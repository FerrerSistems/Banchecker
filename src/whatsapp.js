const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { HttpsProxyAgent } = require('https-proxy-agent');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const emitter = new EventEmitter();
let isReady = false;

// ══════════════════════════════════════════
// LOGGING (Full Debug)
// ══════════════════════════════════════════

function log(tag, msg, data) {
  const heap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] [heap:${heap}MB] ${msg}${extra}`);
}

function logError(tag, msg, err) {
  const heap = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.error(`[${new Date().toISOString()}] [${tag}] [heap:${heap}MB] ❌ ${msg}`);
  if (err) {
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.stack) err.stack.split('\n').slice(0, 5).forEach(l => console.error(`[${tag}]   ${l.trim()}`));
  }
}

// ══════════════════════════════════════════
// GESTOR DE PROXIES ROTATIVOS
// ══════════════════════════════════════════

let proxyList = [];
let currentProxyIndex = 0;

function loadProxies() {
  const filePath = path.join(__dirname, '..', 'proxy.txt');
  if (!fs.existsSync(filePath)) {
    log('PROXY', '⚠️ proxy.txt no encontrado. Se usará conexión directa (sin proxy).');
    return;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    
    proxyList = lines.map(line => {
      // Formato esperado: user:pass@ip:port o ip:port
      const match = line.match(/^(?:(.+):(.+)@)?([^:]+):(\d+)$/);
      if (match) {
        return {
          username: match[1] || null,
          password: match[2] || null,
          ip: match[3],
          port: match[4],
          raw: line
        };
      }
      return null;
    }).filter(p => p !== null);
    
    log('PROXY', `✅ Proxies cargados exitosamente: ${proxyList.length}`);
  } catch (e) {
    logError('PROXY', 'Error leyendo proxy.txt', e);
  }
}

function getNextProxyAgent() {
  if (proxyList.length === 0) return null;
  
  const proxy = proxyList[currentProxyIndex % proxyList.length];
  currentProxyIndex++;
  
  const auth = proxy.username ? `${proxy.username}:${proxy.password}@` : '';
  const proxyUrl = `http://${auth}${proxy.ip}:${proxy.port}`;
  
  log('PROXY', `🔄 Usando proxy [${currentProxyIndex}/${proxyList.length}]: ${proxy.ip}:${proxy.port}`);
  
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    logError('PROXY', `Error creando agente para ${proxy.ip}`, e);
    return null;
  }
}

// ══════════════════════════════════════════
// VERIFICACIÓN POR PAIRING CODE
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const start = Date.now();
  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO POR PAIRING CODE: ${phone}`);
  log('CHECK', '════════════════════════════════════════');

  const cleanPhone = String(phone).replace(/\D/g, '');
  
  if (cleanPhone.length < 8) {
    return { status: 'ERROR', message: '❌ Número inválido (muy corto)', raw: { error: 'invalid_length' } };
  }

  // Crear sesión temporal única
  const tempSessionPath = path.join(config.whatsapp.sessionPath, `temp_${cleanPhone}_${Date.now()}`);
  let tempSock = null;

  try {
    if (!fs.existsSync(tempSessionPath)) fs.mkdirSync(tempSessionPath, { recursive: true });
    const { state } = await useMultiFileAuthState(tempSessionPath);

    // Obtener proxy rotativo
    const proxyAgent = getNextProxyAgent();
    if (proxyAgent) {
      log('CHECK', '🌐 Conexión saldrá a través del proxy configurado.');
    } else {
      log('CHECK', '🌐 Conexión saldrá por IP directa (Railway).');
    }

    // Crear socket temporal (fantasma)
    tempSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
      connectTimeoutMs: 20000,
      agent: proxyAgent, // Inyectar el proxy
      logger: require('pino')({ level: 'silent' }), // Silenciar logs internos de Baileys
    });

    // AÑADIR UN TIMEOUT DE SEGURIDAD (25 segundos)
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('TIMEOUT_SOLICITUD_PAIRING')), 25000)
    );

    log('CHECK', `Solicitando Pairing Code a WhatsApp...`);
    
    // Carrera entre la petición real y el timeout
    const code = await Promise.race([
      tempSock.requestPairingCode(cleanPhone),
      timeoutPromise
    ]);

    // Si llega aquí, WhatsApp generó el código
    const elapsed = Date.now() - start;
    log('CHECK', `✅ CÓDIGO GENERADO: ${code} (${elapsed}ms)`);

    // Cerrar socket inmediatamente
    try { tempSock.end(undefined); } catch (e) {}
    
    // Limpiar carpeta temporal
    setTimeout(() => { try { fs.rmSync(tempSessionPath, { recursive: true, force: true }); } catch (e) {} }, 1000);

    return {
      status: 'ACTIVE',
      message: `✅ Número activo (Código generado: ${code})`,
      raw: { 
        success: true, 
        method: 'pairing_code', 
        code: code, 
        elapsedMs: elapsed,
        proxyUsed: proxyList.length > 0
      }
    };

  } catch (error) {
    const errMsg = error.message || 'Error desconocido';
    log('CHECK', `❌ Error en solicitud: ${errMsg}`);
    
    // Limpiar sesión
    if (tempSock) { try { tempSock.end(undefined); } catch (e) {} }
    try { fs.rmSync(tempSessionPath, { recursive: true, force: true }); } catch (e) {}

    // ══════════════════════════════════════════
    // CLASIFICAR EL ERROR (Full Debug)
    // ══════════════════════════════════════════
    const lowerErr = errMsg.toLowerCase();
    let status = 'ERROR';
    let message = `❌ Error: ${errMsg}`;

    if (lowerErr.includes('timeout_solicitud_pairing')) {
      message = '⏱️ Timeout: WhatsApp no respondió o el proxy falló.';
    } 
    else if (lowerErr.includes('forbidden') || lowerErr.includes('banned') || lowerErr.includes('blocked') || lowerErr.includes('403')) {
      status = 'PERMANENT_BAN';
      message = '❌ Cuenta suspendida o baneada (Error Forbidden/Banned de WhatsApp)';
    } 
    else if (lowerErr.includes('not on whatsapp') || lowerErr.includes('invalid number') || lowerErr.includes('404')) {
      status = 'PERMANENT_BAN';
      message = '❌ No está registrado en WhatsApp (Número inexistente)';
    } 
    else if (lowerErr.includes('too many') || lowerErr.includes('rate') || lowerErr.includes('limit') || lowerErr.includes('429')) {
      status = 'ERROR';
      message = '⚠️ Rate Limit: Demasiadas solicitudes (WhatsApp o Proxy bloqueado)';
    }
    else if (lowerErr.includes('econnrefused') || lowerErr.includes('etimedout') || lowerErr.includes('proxy')) {
      status = 'ERROR';
      message = '🌐 Error de Proxy: El proxy no responde o rechazó la conexión.';
    }

    return {
      status,
      message,
      raw: { 
        success: false, 
        method: 'pairing_code', 
        rawError: errMsg,
        errorStack: error.stack ? error.stack.substring(0, 300) : null,
        proxyUsed: proxyList.length > 0,
        elapsedMs: Date.now() - start
      }
    };
  }
}

// ══════════════════════════════════════════
// STUBS DE COMPATIBILIDAD
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  log('WHATSAPP', 'Módulo de Pairing Code con Proxies inicializado.');
  loadProxies();
  isReady = true;
  return true;
}

function isReadyFn() { return isReady; }
function getDiagnostics() { return { provider: 'baileys_pairing_code', proxies: proxyList.length, ready: isReady }; }

module.exports = {
  initializeWhatsApp,
  checkNumberStatus,
  isReady: isReadyFn,
  getDiagnostics,
  getClient: () => null,
  getQR: () => null,
  getQRBuffer: () => null,
  hasQR: () => false,
  clearQR: () => {},
  getStats: () => ({}),
  hasSession: () => false,
  destroyClient: async () => { isReady = false; },
  isNumberBanned: async (phone) => {
    const r = await checkNumberStatus(phone);
    return ['PERMANENT_BAN', 'TEMPORARY_BAN', 'SPAM_BAN'].includes(r.status);
  },
  emitter,
};
