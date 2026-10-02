/**
 * MÓDULO DE WHATSAPP — ULTRA-DEBUG v2
 * Prints al máximo, captura de TODO error, tracking completo
 * Objetivo: saber EXACTAMENTE qué pasa en cada milisegundo
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// CONTADORES GLOBALES DE DEBUG
// ══════════════════════════════════════════

const stats = {
  totalChecks: 0,
  successChecks: 0,
  failedChecks: 0,
  timeoutChecks: 0,
  storeSuccess: 0,
  storeFail: 0,
  fallbackSuccess: 0,
  fallbackFail: 0,
  avgStoreMs: 0,
  avgFallbackMs: 0,
  memoryPeakMB: 0,
};

const activeChecks = new Map(); // phone → { startTime, step }

// ══════════════════════════════════════════
// HELPER: log con timestamp y contexto
// ══════════════════════════════════════════

function log(tag, msg, data) {
  const ts = new Date().toISOString();
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${ts}] [${tag}] [mem:${mem}MB] ${msg}${extra}`);

  // Actualizar pico de memoria
  const memNum = parseFloat(mem);
  if (memNum > stats.memoryPeakMB) stats.memoryPeakMB = memNum;
}

function logError(tag, msg, err) {
  const ts = new Date().toISOString();
  const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  console.error(`[${ts}] [${tag}] [mem:${mem}MB] ❌ ${msg}`);
  if (err) {
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.code) console.error(`[${tag}]   code: ${err.code}`);
    if (err.label) console.error(`[${tag}]   label: ${err.label}`);
    if (err.isTimeout) console.error(`[${tag}]   isTimeout: true`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(0, 5);
      lines.forEach(l => console.error(`[${tag}]   ${l.trim()}`));
    }
  }
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
let lastEventName = 'none';
let lastEventTime = null;
let initStartTime = null;
let initError = null;
let initAttempts = 0;
let destroyCount = 0;
let reconnectCount = 0;

function setEvent(name) {
  lastEventName = name;
  lastEventTime = new Date();
  log('WHATSAPP-EVENT', `→ ${name}`);
}

// ══════════════════════════════════════════
// TIMEOUT CANCELABLE CON DEBUG
// ══════════════════════════════════════════

function withTimeout(promise, ms, label) {
  log('TIMEOUT', `Iniciando timeout para "${label}" (${ms}ms)`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const startTime = Date.now();

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      const elapsed = Date.now() - startTime;
      const err = new Error(`TIMEOUT_${label}_${ms}ms`);
      err.isTimeout = true;
      err.label = label;
      err.elapsedMs = elapsed;

      logError('TIMEOUT', `"${label}" TIMEOUT después de ${elapsed}ms`);
      reject(err);
    }, ms);

    promise.then(
      (val) => {
        if (settled) {
          log('TIMEOUT', `⚠️ "${label}" resolvió TARDE (después del timeout), ignorado`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;
        log('TIMEOUT', `✅ "${label}" OK en ${elapsed}ms`);
        resolve(val);
      },
      (err) => {
        if (settled) {
          log('TIMEOUT', `⚠️ "${label}" rechazó TARDE (después del timeout): ${err.message}`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;
        logError('TIMEOUT', `"${label}" falló en ${elapsed}ms: ${err.message}`, err);
        reject(err);
      }
    ).catch((e) => {
      logError('TIMEOUT', `Error tardío en "${label}" ignorado`, e);
    });
  });
}

// ══════════════════════════════════════════
// CREAR CLIENTE
// ══════════════════════════════════════════

function createClient() {
  log('WHATSAPP', '═══════ CREANDO CLIENTE ═══════');
  log('WHATSAPP', `Memoria antes: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`);

  let chromePath = config.whatsapp.chromePath;
  log('WHATSAPP', `chromePath desde config: ${chromePath || 'no especificado'}`);

  if (!chromePath) {
    const possiblePaths = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/snap/bin/chromium',
    ];
    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          chromePath = p;
          log('WHATSAPP', `✅ Chrome encontrado: ${p}`);
          break;
        }
      } catch (e) {
        log('WHATSAPP', `Error verificando ${p}: ${e.message}`);
      }
    }
  }

  if (!chromePath) {
    logError('WHATSAPP', 'Chrome no encontrado en ninguna ruta');
    throw new Error('Chrome no encontrado');
  }

  try {
    const chromeStats = fs.statSync(chromePath);
    log('WHATSAPP', `Chrome stats: ${(chromeStats.size / 1024 / 1024).toFixed(1)}MB, mode: ${chromeStats.mode}`);
  } catch (e) {
    log('WHATSAPP', `No se pudo leer stats de Chrome: ${e.message}`);
  }

  const sessionPath = config.whatsapp.sessionPath;
  log('WHATSAPP', `Session path: ${sessionPath}`);
  log('WHATSAPP', `Session existe: ${fs.existsSync(sessionPath)}`);

  if (fs.existsSync(sessionPath)) {
    try {
      const files = fs.readdirSync(sessionPath, { recursive: true });
      log('WHATSAPP', `Archivos en session: ${files.length}`);
    } catch (e) {}
  }

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

  log('WHATSAPP', '✅ Cliente creado');
  log('WHATSAPP', 'Registrando eventos...');

  // ══════════════════════════════════════════
  // EVENTOS CON DEBUG EXTENSO
  // ══════════════════════════════════════════

  newClient.on('qr', async (qr) => {
    setEvent('qr');
    log('WHATSAPP', `📲 QR generado (length: ${qr.length})`);
    log('WHATSAPP', `QR preview: ${qr.substring(0, 30)}...`);
    currentQR = qr;

    try {
      log('WHATSAPP', 'Generando buffer PNG...');
      const QRCode = require('qrcode');
      const t0 = Date.now();
      currentQRBuffer = await QRCode.toBuffer(qr, {
        type: 'png',
        width: 600,
        margin: 2,
        errorCorrectionLevel: 'M',
      });
      const elapsed = Date.now() - t0;
      log('WHATSAPP', `💾 QR en memoria: ${(currentQRBuffer.length / 1024).toFixed(1)}KB en ${elapsed}ms`);
    } catch (e) {
      logError('WHATSAPP', 'Error generando buffer QR', e);
      currentQRBuffer = null;
    }
  });

  newClient.on('loading_screen', (percent, message) => {
    setEvent(`loading_screen:${percent}`);
    log('WHATSAPP', `⏳ ${percent}% — ${message}`);
  });

  newClient.on('change_state', (state) => {
    setEvent(`change_state:${state}`);
    log('WHATSAPP', `🔄 Estado cambió: ${state}`);
  });

  newClient.on('authenticated', () => {
    setEvent('authenticated');
    log('WHATSAPP', '✅ AUTENTICADO');
    emitter.emit('authenticated');
  });

  newClient.on('auth_failure', (msg) => {
    setEvent('auth_failure');
    logError('WHATSAPP', `FALLO AUTH: ${msg}`);
    isReady = false;
    initError = `Auth failure: ${msg}`;
    emitter.emit('auth_failure', msg);
  });

  newClient.on('ready', () => {
    setEvent('ready');
    log('WHATSAPP', '═══════ ✅ CLIENTE LISTO ═══════');
    isReady = true;
    isInitializing = false;

    const info = newClient.info;
    log('WHATSAPP', `Número: +${info?.wid?.user}`);
    log('WHATSAPP', `Nombre: ${info?.pushname}`);
    log('WHATSAPP', `Platform: ${info?.platform}`);
    log('WHATSAPP', `Tiempo total init: ${((Date.now() - initStartTime) / 1000).toFixed(1)}s`);

    emitter.emit('ready', info);
    readyResolvers.forEach(resolve => resolve(newClient));
    readyResolvers = [];
    log('WHATSAPP', `Resolvers ejecutados: OK`);
  });

  newClient.on('disconnected', (reason) => {
    setEvent('disconnected');
    logError('WHATSAPP', `DESCONECTADO: ${reason}`);
    isReady = false;
    isInitializing = false;
    client = null;
    emitter.emit('disconnected', reason);
  });

  newClient.on('error', (err) => {
    setEvent('error');
    logError('WHATSAPP', `EVENTO ERROR: ${err.message}`, err);
    initError = err.message;
  });

  newClient.on('message', (msg) => {
    log('WHATSAPP', `📩 Mensaje de ${msg.from}`);
  });

  newClient.on('message_create', (msg) => {
    log('WHATSAPP', `📤 Mensaje a ${msg.to}`);
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  log('WHATSAPP', '═══════ INICIALIZANDO ═══════');

  if (client && isReady) {
    log('WHATSAPP', 'Cliente ya listo, retornando');
    return client;
  }

  if (isInitializing) {
    log('WHATSAPP', 'Ya inicializando, esperando...');
    return new Promise((resolve) => {
      readyResolvers.push(() => resolve(client));
    });
  }

  initAttempts++;
  log('WHATSAPP', `Intento #${initAttempts}`);
  isInitializing = true;
  initStartTime = Date.now();
  initError = null;

  try {
    client = createClient();
  } catch (e) {
    logError('WHATSAPP', 'Error creando cliente', e);
    isInitializing = false;
    initError = e.message;
    throw e;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logError('WHATSAPP', `TIMEOUT de inicialización (5 min). Último evento: ${lastEventName}`);
      isInitializing = false;
      reject(new Error(`Timeout. Último evento: ${lastEventName}`));
    }, 5 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      const elapsed = Date.now() - initStartTime;
      log('WHATSAPP', `Inicialización completada en ${(elapsed / 1000).toFixed(1)}s`);
      resolve(client);
    });

    log('WHATSAPP', 'Llamando client.initialize()...');
    client.initialize()
      .then(() => log('WHATSAPP', 'client.initialize() resolvió OK'))
      .catch((e) => {
        logError('WHATSAPP', 'client.initialize() falló', e);
        clearTimeout(timeout);
        isInitializing = false;
        initError = e.message;
        reject(e);
      });
  });
}

// ══════════════════════════════════════════
// RESTART
// ══════════════════════════════════════════

async function restartForQR() {
  log('WHATSAPP', '═══════ REINICIANDO PARA QR ═══════');
  reconnectCount++;

  try {
    if (client) {
      log('WHATSAPP', 'Destruyendo cliente actual...');
      try {
        await client.destroy();
        destroyCount++;
        log('WHATSAPP', `Cliente destruido (total destroys: ${destroyCount})`);
      } catch (e) {
        logError('WHATSAPP', 'Error destruyendo', e);
      }
    }

    client = null;
    isReady = false;
    isInitializing = false;
    currentQR = null;
    currentQRBuffer = null;
    initError = null;

    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      log('WHATSAPP', 'Limpiando sesión local...');
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
        log('WHATSAPP', 'Sesión local limpiada');
      } catch (e) {
        logError('WHATSAPP', 'Error limpiando sesión', e);
      }
    }

    log('WHATSAPP', 'Reinicializando...');
    return await initializeWhatsApp();
  } catch (e) {
    logError('WHATSAPP', 'Error en restartForQR', e);
    throw e;
  }
}

async function getReadyClient() {
  if (client && isReady) {
    log('WHATSAPP', 'getReadyClient: ya listo');
    return client;
  }
  if (!client || !isInitializing) {
    log('WHATSAPP', 'getReadyClient: iniciando...');
    return initializeWhatsApp();
  }
  log('WHATSAPP', 'getReadyClient: esperando...');
  return new Promise((resolve) => {
    readyResolvers.push(() => resolve(client));
  });
}

// ══════════════════════════════════════════
// VERIFICACIÓN VÍA STORE (ULTRA DEBUG)
// ══════════════════════════════════════════

async function checkViaStore(c, phone) {
  log('STORE', '═══════ Consulta al store interno ═══════');
  log('STORE', `Número: ${phone}`);

  const widStr = `${phone}@c.us`;
  log('STORE', `WID: ${widStr}`);

  if (!c.pupPage) {
    logError('STORE', 'c.pupPage NO disponible');
    return { ok: false, reason: 'no_pup_page', error: 'pupPage undefined' };
  }

  log('STORE', 'c.pupPage disponible');
  log('STORE', `Page URL: ${c.pupPage.url ? c.pupPage.url() : 'unknown'}`);

  const startTime = Date.now();
  log('STORE', 'Ejecutando evaluate()...');

  try {
    const result = await withTimeout(
      c.pupPage.evaluate(async (widStr) => {
        const debug = {
          steps: [],
          Store_available: typeof window.Store !== 'undefined',
        };

        try {
          if (!window.Store) {
            return { exists: false, reason: 'no_store', debug };
          }
          debug.steps.push('Store OK');

          if (!window.Store.WidFactory) {
            return { exists: false, reason: 'no_wid_factory', debug };
          }
          debug.steps.push('WidFactory OK');

          if (!window.Store.Contact) {
            return { exists: false, reason: 'no_contact_store', debug };
          }
          debug.steps.push('Contact store OK');

          if (!window.Store.Contact.gadd) {
            return { exists: false, reason: 'no_gadd_method', debug };
          }
          debug.steps.push('gadd method OK');

          const wid = window.Store.WidFactory.createWid(widStr);
          debug.wid = wid ? wid._serialized : null;
          debug.steps.push('WID created');

          const contactArr = await window.Store.Contact.gadd(wid);
          debug.contactArrLength = contactArr ? contactArr.length : 0;
          debug.steps.push('gadd() called');

          const contact = contactArr && contactArr[0];
          if (!contact) {
            return { exists: false, reason: 'no_contact_found', debug };
          }
          debug.steps.push('contact found');

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
            debug,
          };
        } catch (e) {
          return {
            exists: false,
            reason: 'eval_error',
            error: e.message,
            stack: (e.stack || '').split('\n').slice(0, 3).join(' | '),
            debug,
          };
        }
      }, widStr),
      10000,
      'store_evaluate'
    );

    const elapsed = Date.now() - startTime;
    log('STORE', `✅ Respondió en ${elapsed}ms`);
    log('STORE', `Resultado:`, result);

    if (!result.exists) {
      log('STORE', `❌ No existe: ${result.reason}`);
      if (result.debug) {
        log('STORE', `Debug pasos: ${JSON.stringify(result.debug.steps)}`);
      }
      return { ok: false, reason: result.reason, error: result.error, debug: result.debug };
    }

    return { ok: true, data: result };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    logError('STORE', `Error después de ${elapsed}ms`, e);
    return { ok: false, reason: 'exception', error: e.message };
  }
}

// ══════════════════════════════════════════
// VERIFICACIÓN VÍA getNumberId (ULTRA DEBUG)
// ══════════════════════════════════════════

async function checkViaGetNumberId(c, phone) {
  log('FALLBACK', '═══════ Consulta getNumberId ═══════');
  log('FALLBACK', `Número: ${phone}`);

  const startTime = Date.now();

  try {
    log('FALLBACK', 'Llamando getNumberId()...');
    const numberId = await withTimeout(
      c.getNumberId(phone),
      25000,
      'getNumberId'
    );
    const elapsed = Date.now() - startTime;

    log('FALLBACK', `getNumberId → ${numberId ? numberId._serialized : 'null'} en ${elapsed}ms`);

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
    const elapsed = Date.now() - startTime;
    logError('FALLBACK', `Error después de ${elapsed}ms`, e);
    return { ok: false, reason: 'error', error: e.message };
  }
}

// ══════════════════════════════════════════
// CHECK NUMBER STATUS (ULTRA DEBUG)
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const checkId = `${phone}_${Date.now()}`;
  const totalStart = Date.now();

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `Check ID: ${checkId}`);
  log('CHECK', `Total checks: ${stats.totalChecks + 1}`);
  log('CHECK', '════════════════════════════════════════');

  activeChecks.set(phone, { startTime: totalStart, step: 'init' });
  stats.totalChecks++;

  // ─── PASO 1: Cliente ───
  log('CHECK', '[PASO 1/4] Obteniendo cliente listo...');
  activeChecks.set(phone, { startTime: totalStart, step: 'get_client' });

  let c;
  try {
    c = await withTimeout(getReadyClient(), 30000, 'get_ready_client');
  } catch (e) {
    logError('CHECK', `PASO 1 FALLÓ: ${e.message}`, e);
    stats.failedChecks++;
    activeChecks.delete(phone);
    return {
      status: 'ERROR',
      message: `❌ WhatsApp no responde (${e.label || 'cliente'})`,
      raw: { error: e.message, step: 'get_client', elapsedMs: Date.now() - totalStart },
    };
  }

  if (!c || !isReady) {
    logError('CHECK', 'PASO 1 FALLÓ: cliente no listo');
    stats.failedChecks++;
    activeChecks.delete(phone);
    return {
      status: 'ERROR',
      message: '❌ WhatsApp no está listo',
      raw: { error: 'client_not_ready', step: 'get_client' },
    };
  }

  log('CHECK', `✅ PASO 1 OK (${Date.now() - totalStart}ms)`);

  // ─── PASO 2: Store ───
  log('CHECK', '[PASO 2/4] Verificando vía store interno...');
  activeChecks.set(phone, { startTime: totalStart, step: 'store' });

  const storeResult = await checkViaStore(c, phone);

  if (storeResult.ok) {
    stats.storeSuccess++;
    const data = storeResult.data;
    const elapsed = Date.now() - totalStart;

    log('CHECK', `✅ PASO 2 OK (store respondió, ${elapsed}ms)`);
    log('CHECK', `isWAContact: ${data.isWAContact}`);
    log('CHECK', `isUser: ${data.isUser}`);
    log('CHECK', `isBusiness: ${data.isBusiness}`);
    log('CHECK', `isBlocked: ${data.isBlocked}`);
    log('CHECK', `name: ${data.name}`);
    log('CHECK', `pushname: ${data.pushname}`);

    // Actualizar promedio
    stats.avgStoreMs = (stats.avgStoreMs + elapsed) / 2;

    if (!data.isWAContact) {
      log('CHECK', '❌ PASO 3: NO es contacto WhatsApp → PERMANENT_BAN');
      stats.failedChecks++;
      activeChecks.delete(phone);
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { ...data, method: 'store', elapsedMs: elapsed },
      };
    }

    if (data.isBlocked) {
      log('CHECK', '⚠️ PASO 3: Está bloqueado por ti → ACTIVE');
      stats.successChecks++;
      activeChecks.delete(phone);
      return {
        status: 'ACTIVE',
        message: '✅ Número activo (bloqueado por ti)',
        raw: { ...data, method: 'store', elapsedMs: elapsed },
      };
    }

    const name = data.name || data.pushname || null;
    log('CHECK', `✅ PASO 3: ACTIVO — ${name || 'sin nombre'}`);
    log('CHECK', `Total: ${elapsed}ms`);
    stats.successChecks++;
    activeChecks.delete(phone);

    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: { ...data, method: 'store', elapsedMs: elapsed },
    };
  }

  // ─── PASO 3: getNumberId fallback ───
  stats.storeFail++;
  log('CHECK', `⚠️ PASO 2 FALLÓ: ${storeResult.reason}`);
  log('CHECK', `[PASO 3/4] Probando getNumberId (fallback)...`);
  activeChecks.set(phone, { startTime: totalStart, step: 'fallback' });

  const fallbackResult = await checkViaGetNumberId(c, phone);

  if (fallbackResult.ok) {
    const elapsed = Date.now() - totalStart;
    stats.fallbackSuccess++;
    stats.avgFallbackMs = (stats.avgFallbackMs + elapsed) / 2;

    if (!fallbackResult.exists) {
      log('CHECK', `❌ PASO 3: No existe (vía getNumberId, ${elapsed}ms)`);
      stats.failedChecks++;
      activeChecks.delete(phone);
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isWAContact: false, method: 'getNumberId', elapsedMs: elapsed },
      };
    }

    log('CHECK', `✅ PASO 3: ACTIVO (vía getNumberId, ${elapsed}ms)`);
    stats.successChecks++;
    activeChecks.delete(phone);
    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: { ...fallbackResult.data, method: 'getNumberId', elapsedMs: elapsed },
    };
  }

  // ─── PASO 4: Todo falló ───
  stats.fallbackFail++;
  stats.failedChecks++;
  stats.timeoutChecks++;

  const elapsed = Date.now() - totalStart;
  logError('CHECK', `❌ PASO 4: TODOS los métodos fallaron (${elapsed}ms)`);
  logError('CHECK', `Store: ${storeResult.reason} — ${storeResult.error}`);
  logError('CHECK', `Fallback: ${fallbackResult.reason} — ${fallbackResult.error}`);
  log('CHECK', '📊 Stats globales:', stats);

  activeChecks.delete(phone);

  return {
    status: 'ERROR',
    message: `⏱️ WhatsApp no responde (${(elapsed / 1000).toFixed(1)}s)`,
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
  log('WHATSAPP', 'Destruyendo cliente...');
  if (client) {
    try {
      await client.destroy();
      destroyCount++;
      log('WHATSAPP', `Cliente destruido (total: ${destroyCount})`);
    } catch (e) {
      logError('WHATSAPP', 'Error destruyendo', e);
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
    hasQR: !!currentQRBuffer,
    lastEvent: lastEventName,
    lastEventTime: lastEventTime?.toISOString() || null,
    initError,
    initAttempts,
    hasClient: !!client,
    reconnectCount,
    destroyCount,
    stats: { ...stats },
    activeChecks: Array.from(activeChecks.entries()).map(([phone, v]) => ({
      phone,
      step: v.step,
      elapsedMs: Date.now() - v.startTime,
    })),
  };
}

function getQRBuffer() { return currentQRBuffer; }
function hasQR() { return !!currentQRBuffer; }
function clearQR() {
  log('WHATSAPP', 'Limpiando QR');
  currentQR = null;
  currentQRBuffer = null;
}

function getStats() {
  return { ...stats };
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
  getStats,
  emitter,
};
