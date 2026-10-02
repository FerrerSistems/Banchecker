/**
 * MÓDULO DE WHATSAPP — ULTRA-DEBUG v3 (MÁXIMO REAL)
 * - Captura TODOS los eventos de Chrome y WhatsApp Web
 * - Detecta errores específicos de la librería
 * - Multiple métodos de store + fallback en cascada
 * - Full stats, memoria, CPU, uptime
 * - Manejo de p-timeout interno
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

const emitter = new EventEmitter();

// ══════════════════════════════════════════
// STATS GLOBALES
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
  consecutiveFailures: 0,
  maxConsecutiveFailures: 0,
  avgStoreMs: 0,
  avgFallbackMs: 0,
  avgTotalMs: 0,
  memoryPeakMB: 0,
  chromeCrashes: 0,
  pageErrors: 0,
  consoleErrors: 0,
  networkErrors: 0,
  startTime: Date.now(),
};

const activeChecks = new Map();

// ══════════════════════════════════════════
// LOGGING CON FULL CONTEXTO
// ══════════════════════════════════════════

function getFullMem() {
  const m = process.memoryUsage();
  return {
    heap: (m.heapUsed / 1024 / 1024).toFixed(1),
    rss: (m.rss / 1024 / 1024).toFixed(1),
    ext: (m.external / 1024 / 1024).toFixed(1),
  };
}

function getUptime() {
  const up = process.uptime();
  const h = Math.floor(up / 3600);
  const m = Math.floor((up % 3600) / 60);
  const s = Math.floor(up % 60);
  return `${h}h${m}m${s}s`;
}

function log(tag, msg, data) {
  const ts = new Date().toISOString();
  const mem = getFullMem();
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${ts}] [${tag}] [heap:${mem.heap}MB rss:${mem.rss}MB up:${getUptime()}] ${msg}${extra}`);

  const memNum = parseFloat(mem.heap);
  if (memNum > stats.memoryPeakMB) stats.memoryPeakMB = memNum;
}

function logError(tag, msg, err) {
  const ts = new Date().toISOString();
  const mem = getFullMem();
  console.error(`[${ts}] [${tag}] [heap:${mem.heap}MB rss:${mem.rss}MB up:${getUptime()}] ❌ ${msg}`);

  if (err) {
    if (err.name) console.error(`[${tag}]   name: ${err.name}`);
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.code) console.error(`[${tag}]   code: ${err.code}`);
    if (err.label) console.error(`[${tag}]   label: ${err.label}`);
    if (err.isTimeout) console.error(`[${tag}]   isTimeout: true`);
    if (err.elapsedMs) console.error(`[${tag}]   elapsedMs: ${err.elapsedMs}`);

    // Stack COMPLETO (no truncar)
    if (err.stack) {
      const lines = err.stack.split('\n');
      console.error(`[${tag}]   ─── STACK COMPLETO (${lines.length} líneas) ───`);
      lines.forEach(l => console.error(`[${tag}]   ${l}`));
      console.error(`[${tag}]   ─── FIN STACK ───`);
    }

    // Causa encadenada
    if (err.cause) {
      console.error(`[${tag}]   ─── CAUSA ───`);
      console.error(`[${tag}]   ${err.cause.message}`);
      if (err.cause.stack) {
        err.cause.stack.split('\n').slice(0, 10).forEach(l =>
          console.error(`[${tag}]   ${l}`)
        );
      }
    }
  }
}

// ══════════════════════════════════════════
// DETECCIÓN DE ERRORES ESPECÍFICOS
// ══════════════════════════════════════════

function classifyError(err) {
  if (!err) return 'UNKNOWN';

  const msg = (err.message || '').toLowerCase();
  const name = (err.name || '').toLowerCase();

  if (err.isTimeout || msg.includes('timeout')) return 'TIMEOUT';
  if (msg.includes('execution context was destroyed')) return 'CONTEXT_DESTROYED';
  if (msg.includes('target closed')) return 'TARGET_CLOSED';
  if (msg.includes('session closed')) return 'SESSION_CLOSED';
  if (msg.includes('protocol error')) return 'PROTOCOL_ERROR';
  if (msg.includes('navigator is not defined')) return 'NAVIGATOR_UNDEFINED';
  if (msg.includes('evaluation failed')) return 'EVALUATION_FAILED';
  if (msg.includes('window.store is undefined')) return 'STORE_UNDEFINED';
  if (msg.includes('cannot read propert')) return 'NULL_PROPERTY';
  if (msg.includes('not a function')) return 'NOT_A_FUNCTION';
  if (msg.includes('invalid wid')) return 'INVALID_WID';
  if (msg.includes('detached frame')) return 'DETACHED_FRAME';
  if (msg.includes('navigation failed')) return 'NAVIGATION_FAILED';
  if (msg.includes('page crashed')) return 'PAGE_CRASHED';
  if (name.includes('timeouterror')) return 'TIMEOUT_LIB';

  return 'UNKNOWN';
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
let pageListenersAttached = false;

function setEvent(name) {
  lastEventName = name;
  lastEventTime = new Date();
  log('WHATSAPP-EVENT', `→ ${name}`);
}

// ══════════════════════════════════════════
// TIMEOUT CANCELABLE
// ══════════════════════════════════════════

function withTimeout(promise, ms, label) {
  log('TIMEOUT', `Iniciando "${label}" (${ms}ms)`);

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
      logError('TIMEOUT', `"${label}" TIMEOUT tras ${elapsed}ms`, err);
      reject(err);
    }, ms);

    promise.then(
      (val) => {
        if (settled) {
          log('TIMEOUT', `⚠️ "${label}" resolvió tarde (ignorado)`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        log('TIMEOUT', `✅ "${label}" OK en ${Date.now() - startTime}ms`);
        resolve(val);
      },
      (err) => {
        if (settled) {
          log('TIMEOUT', `⚠️ "${label}" rechazó tarde (ignorado): ${err.message}`);
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        logError('TIMEOUT', `"${label}" falló en ${Date.now() - startTime}ms`, err);
        reject(err);
      }
    ).catch((e) => {
      logError('TIMEOUT', `Error tardío en "${label}"`, e);
    });
  });
}

// ══════════════════════════════════════════
// ADJUNTAR LISTENERS A LA PÁGINA CHROME
// ══════════════════════════════════════════

function attachPageListeners(c) {
  if (!c.pupPage || pageListenersAttached) {
    log('PAGE', `No se adjuntan listeners (pupPage: ${!!c.pupPage}, ya adjuntados: ${pageListenersAttached})`);
    return;
  }

  log('PAGE', '═══════ ADJUNTANDO LISTENERS A LA PÁGINA ═══════');

  try {
    // ── Console de la página ──
    c.pupPage.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();

      if (type === 'error') {
        stats.consoleErrors++;
        log('PAGE-CONSOLE-ERROR', text);
      } else if (type === 'warning') {
        log('PAGE-CONSOLE-WARN', text);
      } else {
        log('PAGE-CONSOLE', `[${type}] ${text}`);
      }
    });

    // ── Excepciones JS de la página ──
    c.pupPage.on('pageerror', (err) => {
      stats.pageErrors++;
      logError('PAGE-ERROR', 'Excepción JS en la página:', err);
    });

    // ── Respuestas HTTP fallidas ──
    c.pupPage.on('response', (response) => {
      const status = response.status();
      if (status >= 400) {
        stats.networkErrors++;
        log('PAGE-NET', `HTTP ${status} → ${response.url().substring(0, 100)}`);
      }
    });

    // ── Request failures ──
    c.pupPage.on('requestfailed', (request) => {
      stats.networkErrors++;
      const failure = request.failure();
      log('PAGE-NET-FAIL', `Falló: ${request.url().substring(0, 100)} → ${failure?.errorText}`);
    });

    // ── Frame detach ──
    c.pupPage.on('framedetached', (frame) => {
      log('PAGE-FRAME', `Frame detached: ${frame.url()?.substring(0, 80)}`);
    });

    // ── Frame navigation ──
    c.pupPage.on('framenavigated', (frame) => {
      if (frame === c.pupPage.mainFrame()) {
        log('PAGE-NAV', `Frame principal navegó: ${frame.url()?.substring(0, 80)}`);
      }
    });

    pageListenersAttached = true;
    log('PAGE', '✅ Listeners adjuntados');
  } catch (e) {
    logError('PAGE', 'Error adjuntando listeners', e);
  }
}

// ══════════════════════════════════════════
// CREAR CLIENTE
// ══════════════════════════════════════════

function createClient() {
  log('WHATSAPP', '═══════ CREANDO CLIENTE ═══════');
  log('WHATSAPP', `Stats: checks=${stats.totalChecks}, ok=${stats.successChecks}, fail=${stats.failedChecks}`);
  log('WHATSAPP', `Reconexiones: ${reconnectCount}, destroys: ${destroyCount}`);

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
  log('WHATSAPP', `Chrome: ${chromePath}`);

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

  log('WHATSAPP', '✅ Cliente creado, registrando eventos...');
  pageListenersAttached = false;

  // ══════════════════════════════════════════
  // EVENTOS
  // ══════════════════════════════════════════

  newClient.on('qr', async (qr) => {
    setEvent('qr');
    log('WHATSAPP', `📲 QR (length: ${qr.length})`);
    currentQR = qr;

    try {
      const QRCode = require('qrcode');
      currentQRBuffer = await QRCode.toBuffer(qr, {
        type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'M',
      });
      log('WHATSAPP', `💾 QR buffer: ${(currentQRBuffer.length / 1024).toFixed(1)}KB`);
    } catch (e) {
      logError('WHATSAPP', 'Error buffer QR', e);
      currentQRBuffer = null;
    }
  });

  newClient.on('loading_screen', (percent, message) => {
    setEvent(`loading_screen:${percent}`);
    log('WHATSAPP', `⏳ ${percent}% — ${message}`);
  });

  newClient.on('change_state', (state) => {
    setEvent(`change_state:${state}`);
    log('WHATSAPP', `🔄 Estado: ${state}`);
  });

  newClient.on('authenticated', () => {
    setEvent('authenticated');
    log('WHATSAPP', '✅ AUTENTICADO');
    // Adjuntar listeners de página justo ahora
    try { attachPageListeners(newClient); } catch (e) {}
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
    log('WHATSAPP', `Init total: ${((Date.now() - initStartTime) / 1000).toFixed(1)}s`);

    // Adjuntar listeners de página si no se hizo
    try { attachPageListeners(newClient); } catch (e) {}

    emitter.emit('ready', info);
    readyResolvers.forEach(resolve => resolve(newClient));
    readyResolvers = [];
  });

  newClient.on('disconnected', (reason) => {
    setEvent('disconnected');
    logError('WHATSAPP', `DESCONECTADO: ${reason}`);
    isReady = false;
    isInitializing = false;
    client = null;
    pageListenersAttached = false;
    emitter.emit('disconnected', reason);
  });

  newClient.on('error', (err) => {
    setEvent('error');
    const kind = classifyError(err);
    logError('WHATSAPP', `EVENTO ERROR [${kind}]: ${err.message}`, err);
    initError = err.message;
  });

  return newClient;
}

// ══════════════════════════════════════════
// INICIALIZAR
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  log('WHATSAPP', '═══════ INICIALIZANDO ═══════');

  if (client && isReady) return client;
  if (isInitializing) {
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
    isInitializing = false;
    initError = e.message;
    throw e;
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      logError('WHATSAPP', `TIMEOUT 5min. Último evento: ${lastEventName}`);
      isInitializing = false;
      reject(new Error(`Timeout. Evento: ${lastEventName}`));
    }, 5 * 60 * 1000);

    readyResolvers.push(() => {
      clearTimeout(timeout);
      isInitializing = false;
      resolve(client);
    });

    client.initialize()
      .then(() => log('WHATSAPP', 'client.initialize() OK'))
      .catch((e) => {
        logError('WHATSAPP', 'client.initialize() falló', e);
        clearTimeout(timeout);
        isInitializing = false;
        initError = e.message;
        reject(e);
      });
  });
}

async function restartForQR() {
  log('WHATSAPP', '═══════ RESTART PARA QR ═══════');
  reconnectCount++;

  try {
    if (client) {
      try {
        await client.destroy();
        destroyCount++;
      } catch (e) {
        logError('WHATSAPP', 'Error destroy', e);
      }
    }

    client = null;
    isReady = false;
    isInitializing = false;
    currentQR = null;
    currentQRBuffer = null;
    initError = null;
    pageListenersAttached = false;

    const sessionDir = config.whatsapp.sessionPath;
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (e) {}
    }

    return await initializeWhatsApp();
  } catch (e) {
    logError('WHATSAPP', 'Error restartForQR', e);
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
// VERIFICACIÓN VÍA STORE — MÚLTIPLES MÉTODOS
// ══════════════════════════════════════════

async function checkViaStore(c, phone) {
  log('STORE', '═══════ Consulta store ═══════');
  log('STORE', `Número: ${phone}`);

  if (!c.pupPage) {
    logError('STORE', 'c.pupPage NO disponible');
    return { ok: false, reason: 'no_pup_page' };
  }

  // Verificar si la página está cerrada
  try {
    if (typeof c.pupPage.isClosed === 'function' && c.pupPage.isClosed()) {
      logError('STORE', 'pupPage ESTÁ CERRADA');
      return { ok: false, reason: 'page_closed' };
    }
  } catch (e) {}

  const widStr = `${phone}@c.us`;
  const startTime = Date.now();

  try {
    // Verificar estado del store primero (rápido)
    const storeOk = await withTimeout(
      c.pupPage.evaluate(() => {
        return {
          hasStore: typeof window.Store !== 'undefined',
          hasWidFactory: window.Store?.WidFactory !== undefined,
          hasContact: window.Store?.Contact !== undefined,
          hasGadd: typeof window.Store?.Contact?.gadd === 'function',
          hasGet: typeof window.Store?.Contact?.get === 'function',
          hasGetModelsArray: typeof window.Store?.Contact?.getModelsArray === 'function',
          waVersion: window.Debug?.VERSION?.toString() || 'unknown',
        };
      }),
      5000,
      'store_check'
    );

    log('STORE', `Estado del store:`, storeOk);

    if (!storeOk.hasStore) {
      logError('STORE', 'window.Store NO existe');
      return { ok: false, reason: 'no_store' };
    }

    // Intentar método 1: gadd
    if (storeOk.hasGadd) {
      log('STORE', 'Probando método 1: Contact.gadd()');
      try {
        const result = await withTimeout(
          c.pupPage.evaluate(async (widStr) => {
            try {
              const wid = window.Store.WidFactory.createWid(widStr);
              const arr = await window.Store.Contact.gadd(wid);
              const contact = arr && arr[0];

              if (!contact) return { exists: false, reason: 'no_contact_gadd' };

              return {
                exists: true,
                isWAContact: !!contact.isWAContact,
                isUser: !!contact.isUser,
                isBusiness: !!contact.isBusiness,
                isBlocked: !!contact.isBlocked,
                name: contact.name || null,
                pushname: contact.pushname || null,
                number: contact.id?._serialized || null,
                method: 'gadd',
              };
            } catch (e) {
              return { exists: false, reason: 'eval_error_gadd', error: e.message };
            }
          }, widStr),
          10000,
          'store_gadd'
        );

        const elapsed = Date.now() - startTime;
        log('STORE', `gadd → ${elapsed}ms`, result);

        if (result.exists) return { ok: true, data: result };

        log('STORE', `gadd no encontró: ${result.reason}`);
      } catch (e) {
        logError('STORE', 'gadd falló', e);
      }
    }

    // Método 2: get (por WID)
    if (storeOk.hasGet) {
      log('STORE', 'Probando método 2: Contact.get()');
      try {
        const result = await withTimeout(
          c.pupPage.evaluate(async (widStr) => {
            try {
              const wid = window.Store.WidFactory.createWid(widStr);
              let contact = window.Store.Contact.get(wid);

              if (!contact) {
                // get() puede devolver undefined si no está en store
                // Probar con getModelsArray
                const all = window.Store.Contact.getModelsArray();
                contact = all.find(c => c.id?._serialized === widStr);
              }

              if (!contact) return { exists: false, reason: 'no_contact_get' };

              return {
                exists: true,
                isWAContact: !!contact.isWAContact,
                isUser: !!contact.isUser,
                isBusiness: !!contact.isBusiness,
                isBlocked: !!contact.isBlocked,
                name: contact.name || null,
                pushname: contact.pushname || null,
                number: contact.id?._serialized || null,
                method: 'get',
              };
            } catch (e) {
              return { exists: false, reason: 'eval_error_get', error: e.message };
            }
          }, widStr),
          10000,
          'store_get'
        );

        const elapsed = Date.now() - startTime;
        log('STORE', `get → ${elapsed}ms`, result);

        if (result.exists) return { ok: true, data: result };

        log('STORE', `get no encontró: ${result.reason}`);
      } catch (e) {
        logError('STORE', 'get falló', e);
      }
    }

    // Nada funcionó
    return { ok: false, reason: 'all_methods_failed' };
  } catch (e) {
    logError('STORE', 'Error general', e);
    return { ok: false, reason: classifyError(e), error: e.message };
  }
}

// ══════════════════════════════════════════
// FALLBACK: getNumberId
// ══════════════════════════════════════════

async function checkViaGetNumberId(c, phone) {
  log('FALLBACK', '═══════ getNumberId ═══════');

  const startTime = Date.now();

  try {
    const numberId = await withTimeout(
      c.getNumberId(phone),
      25000,
      'getNumberId'
    );
    const elapsed = Date.now() - startTime;

    log('FALLBACK', `→ ${numberId ? numberId._serialized : 'null'} en ${elapsed}ms`);

    if (!numberId) return { ok: true, exists: false };

    return {
      ok: true,
      exists: true,
      data: {
        exists: true,
        isWAContact: true,
        number: numberId._serialized,
        name: null,
        pushname: null,
        method: 'getNumberId',
      },
    };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    const kind = classifyError(e);
    logError('FALLBACK', `Error [${kind}] tras ${elapsed}ms`, e);
    return { ok: false, reason: kind, error: e.message };
  }
}

// ══════════════════════════════════════════
// CHECK NUMBER STATUS
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const totalStart = Date.now();

  log('CHECK', '════════════════════════════════════════');
  log('CHECK', `VERIFICANDO: ${phone}`);
  log('CHECK', `Check #${stats.totalChecks + 1} | Fallos consecutivos: ${stats.consecutiveFailures}`);
  log('CHECK', '════════════════════════════════════════');

  activeChecks.set(phone, { startTime: totalStart, step: 'init' });
  stats.totalChecks++;

  // PASO 1: Cliente
  log('CHECK', '[PASO 1/4] Obteniendo cliente...');
  let c;
  try {
    c = await withTimeout(getReadyClient(), 30000, 'get_ready_client');
  } catch (e) {
    stats.failedChecks++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures > stats.maxConsecutiveFailures) {
      stats.maxConsecutiveFailures = stats.consecutiveFailures;
    }
    activeChecks.delete(phone);
    const kind = classifyError(e);
    return {
      status: 'ERROR',
      message: `❌ WhatsApp no responde [${kind}]`,
      raw: { error: e.message, kind, step: 'get_client' },
    };
  }

  if (!c || !isReady) {
    stats.failedChecks++;
    stats.consecutiveFailures++;
    activeChecks.delete(phone);
    return {
      status: 'ERROR',
      message: '❌ WhatsApp no está listo',
      raw: { error: 'client_not_ready' },
    };
  }

  log('CHECK', `✅ PASO 1 OK (${Date.now() - totalStart}ms)`);

  // PASO 2: Store
  log('CHECK', '[PASO 2/4] Verificando vía store...');
  const storeResult = await checkViaStore(c, phone);

  if (storeResult.ok) {
    stats.storeSuccess++;
    stats.consecutiveFailures = 0;
    const data = storeResult.data;
    const elapsed = Date.now() - totalStart;
    stats.avgStoreMs = stats.avgStoreMs === 0 ? elapsed : (stats.avgStoreMs + elapsed) / 2;
    stats.avgTotalMs = stats.avgTotalMs === 0 ? elapsed : (stats.avgTotalMs + elapsed) / 2;

    log('CHECK', `✅ PASO 2 OK (${elapsed}ms) — método: ${data.method}`);
    log('CHECK', `isWAContact: ${data.isWAContact}`);
    log('CHECK', `isUser: ${data.isUser}`);
    log('CHECK', `isBlocked: ${data.isBlocked}`);
    log('CHECK', `name: ${data.name}`);
    log('CHECK', `pushname: ${data.pushname}`);

    if (!data.isWAContact) {
      stats.successChecks++;
      activeChecks.delete(phone);
      log('CHECK', '❌ PERMANENT_BAN (no es contacto)');
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { ...data, elapsedMs: elapsed },
      };
    }

    if (data.isBlocked) {
      stats.successChecks++;
      activeChecks.delete(phone);
      log('CHECK', '⚠️ Está bloqueado por ti → ACTIVE');
      return {
        status: 'ACTIVE',
        message: '✅ Número activo (bloqueado por ti)',
        raw: { ...data, elapsedMs: elapsed },
      };
    }

    stats.successChecks++;
    activeChecks.delete(phone);
    log('CHECK', `✅ ACTIVO — ${data.name || data.pushname || 'sin nombre'}`);
    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: { ...data, elapsedMs: elapsed },
    };
  }

  // PASO 3: getNumberId
  stats.storeFail++;
  log('CHECK', `⚠️ PASO 2 FALLÓ: ${storeResult.reason}`);
  log('CHECK', '[PASO 3/4] Probando getNumberId...');

  const fallbackResult = await checkViaGetNumberId(c, phone);

  if (fallbackResult.ok) {
    stats.fallbackSuccess++;
    const elapsed = Date.now() - totalStart;
    stats.avgFallbackMs = stats.avgFallbackMs === 0 ? elapsed : (stats.avgFallbackMs + elapsed) / 2;

    if (!fallbackResult.exists) {
      stats.successChecks++;
      stats.consecutiveFailures = 0;
      activeChecks.delete(phone);
      log('CHECK', `❌ No existe (${elapsed}ms)`);
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { isWAContact: false, elapsedMs: elapsed },
      };
    }

    stats.successChecks++;
    stats.consecutiveFailures = 0;
    activeChecks.delete(phone);
    log('CHECK', `✅ ACTIVO (${elapsed}ms)`);
    return {
      status: 'ACTIVE',
      message: '✅ Número activo',
      raw: { ...fallbackResult.data, elapsedMs: elapsed },
    };
  }

  // PASO 4: Todo falló
  stats.fallbackFail++;
  stats.failedChecks++;
  stats.consecutiveFailures++;
  if (stats.consecutiveFailures > stats.maxConsecutiveFailures) {
    stats.maxConsecutiveFailures = stats.consecutiveFailures;
  }

  const elapsed = Date.now() - totalStart;
  logError('CHECK', `❌ TODOS los métodos fallaron (${elapsed}ms)`);
  logError('CHECK', `  store: ${storeResult.reason} — ${storeResult.error || 'N/A'}`);
  logError('CHECK', `  fallback: ${fallbackResult.reason} — ${fallbackResult.error || 'N/A'}`);
  log('CHECK', '📊 Stats:', stats);
  activeChecks.delete(phone);

  return {
    status: 'ERROR',
    message: `⏱️ WhatsApp no responde (${(elapsed / 1000).toFixed(1)}s)`,
    raw: {
      storeError: storeResult.error || storeResult.reason,
      fallbackError: fallbackResult.error || fallbackResult.reason,
      elapsedMs: elapsed,
      consecutiveFailures: stats.consecutiveFailures,
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
    try { await client.destroy(); destroyCount++; } catch (e) {}
    client = null;
    isReady = false;
    isInitializing = false;
    pageListenersAttached = false;
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
    pageListenersAttached,
    stats: { ...stats },
    uptime: getUptime(),
    memory: getFullMem(),
    activeChecks: Array.from(activeChecks.entries()).map(([phone, v]) => ({
      phone, step: v.step, elapsedMs: Date.now() - v.startTime,
    })),
  };
}

function getQRBuffer() { return currentQRBuffer; }
function hasQR() { return !!currentQRBuffer; }
function clearQR() { currentQR = null; currentQRBuffer = null; }
function getStats() { return { ...stats }; }

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
  classifyError,
  emitter,
};
