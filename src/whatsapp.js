/**
 * MÓDULO DE WHATSAPP — VERIFICACIÓN RÁPIDA POR STORE INTERNO
 * - checkNumberStatus usa el store interno de WhatsApp (1-3s)
 * - Fallback a getNumberId si el store falla (con timeout 20s)
 * - Full prints paso a paso
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// ESTADO
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

function setEvent(name) {
  lastEventName = name;
  lastEventTime = new Date();
  console.log(`[WHATSAPP-EVENT] ${new Date().toISOString()} → ${name}`);
}

// ══════════════════════════════════════════
// TIMEOUT CANCELABLE
// Evita "unhandled rejection" cuando la promesa original termina después del timeout
// ══════════════════════════════════════════

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`TIMEOUT_${label}_${ms}ms`);
      err.isTimeout = true;
      err.label = label;
      reject(err);
    }, ms);

    promise.then(
      (val) => {
        if (settled) {
          console.log(`[TIMEOUT] ⚠️ ${label} resolvió después del timeout (ignorado)`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        resolve(val);
      },
      (err) => {
        if (settled) {
          console.log(`[TIMEOUT] ⚠️ ${label} rechazó después del timeout (ignorado): ${err.message}`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      }
    ).catch((e) => {
      // Capturar cualquier error tardío para evitar unhandledRejection
      console.log(`[TIMEOUT] ⚠️ Error tardío ignorado en ${label}: ${e.message}`);
    });
  });
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
        if (fs.existsSync(p)) { chromePath = p; break; }
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

  console.log('[WHATSAPP] Cliente creado\n');

  // ══════════════════════════════════════════
  // EVENTOS
  // ══════════════════════════════════════════

  newClient.on('qr', async (qr) => {
    setEvent('qr');
    console.log(`[WHATSAPP] 📲 QR generado (length: ${qr.length})`);
    currentQR = qr;

    try {
      const QRCode = require('qrcode');
      currentQRBuffer = await QRCode.toBuffer(qr, {
        type: 'png',
        width: 600,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      console.log(`[WHATSAPP] 💾 QR en memoria (${(currentQRBuffer.length / 1024).toFixed(1)} KB)`);
    } catch (e) {
      console.error('[WHATSAPP] ❌ Error buffer QR:', e.message);
      currentQRBuffer = null;
    }
  });

  newClient.on('loading_screen', (percent, message) => {
    setEvent(`loading_screen:${percent}`);
    console.log(`[WHATSAPP] ⏳ ${percent}% — ${message}`);
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
// INICIALIZAR / RESTART
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
    isInitializing = false;
    initError = e.message;
    throw e;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.error(`[WHATSAPP] ❌ TIMEOUT — Evento: ${lastEventName}`);
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
    initError = null;

    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {}
    }

    return await initializeWhatsApp();
  } catch (e) {
    console.error('[WHATSAPP] ❌ Error restartForQR:', e.message);
    throw e;
  }
}

async function getReadyClient() {
  if (client && isReady) return client;
  if (!client || !isInitializing) return initializeWhatsApp();
  return new Promise((resolve) => {
    readyResolvers.push(() => resolve(client));
  });
}

// ══════════════════════════════════════════
// 🚀 VERIFICACIÓN VÍA STORE INTERNO (RÁPIDA)
// Consulta directamente el store de WhatsApp (1-3s)
// ══════════════════════════════════════════

async function checkViaStore(c, phone) {
  console.log(`\n[STORE] ═══ Consultando store interno ═══`);
  console.log(`[STORE] Número: ${phone}`);

  const widStr = `${phone}@c.us`;

  try {
    // Verificar que la página exista
    if (!c.pupPage) {
      console.log('[STORE] ❌ c.pupPage no disponible');
      return { ok: false, reason: 'no_pup_page' };
    }

    console.log('[STORE] Ejecutando evaluate()...');
    const startTime = Date.now();

    const result = await withTimeout(
      c.pupPage.evaluate(async (widStr) => {
        try {
          const wid = window.Store.WidFactory.createWid(widStr);
          const [contact] = await window.Store.Contact.gadd(wid);

          if (!contact) {
            return { exists: false, reason: 'no_contact' };
          }

          return {
            exists: true,
            isWAContact: !!contact.isWAContact,
            isUser: !!contact.isUser,
            isBusiness: !!contact.isBusiness,
            isEnterprise: !!contact.isEnterprise,
            isBlocked: !!contact.isBlocked,
            name: contact.name || null,
            pushname: contact.pushname || null,
            number: contact.id?._serialized || null,
          };
        } catch (e) {
          return { exists: false, reason: 'eval_error', error: e.message };
        }
      }, widStr),
      10000,
      'store_evaluate'
    );

    const elapsed = Date.now() - startTime;
    console.log(`[STORE] ✅ Respondió en ${elapsed}ms`);
    console.log(`[STORE] Resultado:`, JSON.stringify(result));

    if (!result.exists) {
      console.log(`[STORE] ❌ No existe (${result.reason})`);
      return { ok: false, reason: result.reason, error: result.error };
    }

    return { ok: true, data: result };
  } catch (e) {
    console.error(`[STORE] ❌ Error: ${e.message}`);
    if (e.isTimeout) {
      return { ok: false, reason: 'timeout', error: e.message };
    }
    return { ok: false, reason: 'exception', error: e.message };
  }
}

// ══════════════════════════════════════════
// 🔁 VERIFICACIÓN FALLBACK VÍA getNumberId (lenta)
// ══════════════════════════════════════════

async function checkViaGetNumberId(c, phone) {
  console.log(`\n[FALLBACK] ═══ getNumberId (lento) ═══`);

  try {
    const startTime = Date.now();
    const numberId = await withTimeout(
      c.getNumberId(phone),
      25000,
      'getNumberId'
    );
    const elapsed = Date.now() - startTime;

    console.log(`[FALLBACK] getNumberId → ${numberId ? numberId._serialized : 'null'} (${elapsed}ms)`);

    if (!numberId) {
      return { ok: true, exists: false };
    }

    return {
      ok: true,
      exists: true,
      data: {
        exists: true,
        isWAContact: true,
        number: numberId._serialized,
        name: null,
        pushname: null,
      },
    };
  } catch (e) {
    console.error(`[FALLBACK] ❌ Error: ${e.message}`);
    return { ok: false, reason: 'error', error: e.message };
  }
}

// ══════════════════════════════════════════
// 🔍 VERIFICAR ESTADO DE UN NÚMERO
// Cascada: Store → getNumberId → Error
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  console.log(`\n[CHECK] ══════════════════════════════════════`);
  console.log(`[CHECK] VERIFICANDO: ${phone}`);
  console.log(`[CHECK] ══════════════════════════════════════`);
  const totalStart = Date.now();

  // ─── Paso 1: Obtener cliente ───
  console.log('[CHECK] Paso 1: Obteniendo cliente...');
  let c;
  try {
    c = await withTimeout(getReadyClient(), 30000, 'get_ready_client');
  } catch (e) {
    console.error(`[CHECK] ❌ Cliente no disponible: ${e.message}`);
    return {
      status: 'ERROR',
      message: `❌ WhatsApp no responde (${e.label || 'client'})`,
      raw: { error: e.message, step: 'get_client' },
    };
  }

  if (!c || !isReady) {
    console.error('[CHECK] ❌ Cliente no listo');
    return {
      status: 'ERROR',
      message: '❌ WhatsApp no está listo',
      raw: { error: 'client_not_ready' },
    };
  }
  console.log('[CHECK] ✅ Cliente OK');

  // ─── Paso 2: Verificar vía store (rápido) ───
  console.log('\n[CHECK] Paso 2: Verificando vía store interno...');
  const storeResult = await checkViaStore(c, phone);

  if (storeResult.ok) {
    const data = storeResult.data;
    const elapsed = Date.now() - totalStart;
    console.log(`[CHECK] ✅ Vía store OK (${elapsed}ms)`);
    console.log(`[CHECK] isWAContact: ${data.isWAContact}`);
    console.log(`[CHECK] isUser: ${data.isUser}`);
    console.log(`[CHECK] isBlocked: ${data.isBlocked}`);

    // Interpretación
    if (!data.isWAContact) {
      console.log('[CHECK] ❌ No es contacto de WhatsApp → PERMANENT_BAN');
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp (baneo permanente o número inexistente)',
        raw: { ...data, method: 'store', elapsedMs: elapsed },
      };
    }

    // Verificar si está bloqueado por nosotros
    if (data.isBlocked) {
      console.log('[CHECK] ⚠️ Está bloqueado por nosotros');
      return {
        status: 'ACTIVE',
        message: '✅ Número activo (está bloqueado por ti)',
        raw: { ...data, method: 'store', elapsedMs: elapsed },
      };
    }

    // Está activo
    const name = data.name || data.pushname || null;
    console.log(`[CHECK] ✅ ACTIVO — ${name || 'sin nombre'}`);

    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: { ...data, method: 'store', elapsedMs: elapsed },
    };
  }

  // ─── Paso 3: Si el store falló, intentar getNumberId ───
  console.log(`\n[CHECK] ⚠️ Store falló (${storeResult.reason}). Probando getNumberId...`);

  const fallbackResult = await checkViaGetNumberId(c, phone);

  if (fallbackResult.ok) {
    const elapsed = Date.now() - totalStart;

    if (!fallbackResult.exists) {
      console.log(`[CHECK] ❌ No existe (vía getNumberId, ${elapsed}ms)`);
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp (baneo permanente o número inexistente)',
        raw: { isWAContact: false, method: 'getNumberId', elapsedMs: elapsed },
      };
    }

    console.log(`[CHECK] ✅ ACTIVO (vía getNumberId, ${elapsed}ms)`);
    return {
      status: 'ACTIVE',
      message: '✅ Número activo (verificado)',
      raw: { ...fallbackResult.data, method: 'getNumberId', elapsedMs: elapsed },
    };
  }

  // ─── Paso 4: Todo falló ───
  const elapsed = Date.now() - totalStart;
  console.error(`\n[CHECK] ❌ TODOS los métodos fallaron (${elapsed}ms)`);
  console.error(`[CHECK] Store: ${storeResult.reason} — ${storeResult.error}`);
  console.error(`[CHECK] getNumberId: ${fallbackResult.reason} — ${fallbackResult.error}`);

  return {
    status: 'ERROR',
    message: `⏱️ WhatsApp no responde (${(elapsed / 1000).toFixed(1)}s). Intenta de nuevo.`,
    raw: {
      storeError: storeResult.error || storeResult.reason,
      fallbackError: fallbackResult.error || fallbackResult.reason,
      elapsedMs: elapsed,
    },
  };
}

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

async function isNumberBanned(phone) {
  const result = await checkNumberStatus(phone);
  return result.status !== 'ACTIVE' && result.status !== 'VERIFY';
}

async function destroyClient() {
  if (client) {
    try { await client.destroy(); } catch (e) {}
    client = null;
    isReady = false;
    isInitializing = false;
  }
}

function getDiagnostics() {
  return {
    ready: isReady,
    initializing: isInitializing,
    hasQR: !!currentQRBuffer,
    lastEvent: lastEventName,
    lastEventTime: lastEventTime?.toISOString() || null,
    initError,
    initAttempts,
    hasClient: !!client,
  };
}

function getQRBuffer() { return currentQRBuffer; }
function hasQR() { return !!currentQRBuffer; }
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
