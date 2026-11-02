/**
 * MÓDULO DE VERIFICACIÓN DE BAN vía Z-API (ROBUSTO)
 * - No usa Baileys ni QR.
 * - Consulta /mobile/registration-available.
 * - Extrae appealToken si el número está bloqueado.
 * - Si faltan credenciales, se detiene con un mensaje claro.
 */

const EventEmitter = require('events');

const emitter = new EventEmitter();
let isReady = false;

// ══════════════════════════════════════════
// CONFIGURACIÓN DEL PROVEEDOR
// ══════════════════════════════════════════

const PROVIDER = {
  name: 'zapi',
  zapi: {
    baseUrl: 'https://api.z-api.io',
    instanceId: process.env.ZAPI_INSTANCE_ID || '',
    token: process.env.ZAPI_TOKEN || '',
    clientToken: process.env.ZAPI_CLIENT_TOKEN || '',
  },
  timeoutMs: 30000,
};

// ══════════════════════════════════════════
// LOGGING EXTREMO
// ══════════════════════════════════════════

function log(tag, msg, data) {
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  const mem = process.memoryUsage();
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  console.log(`[${new Date().toISOString()}] [${tag}] [heap:${heap}MB] ${msg}${extra}`);
}

function logError(tag, msg, err) {
  const mem = process.memoryUsage();
  const heap = (mem.heapUsed / 1024 / 1024).toFixed(1);
  console.error(`[${new Date().toISOString()}] [${tag}] [heap:${heap}MB] ❌ ${msg}`);
  if (err) {
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.stack) {
      err.stack.split('\n').slice(0, 5).forEach(l => console.error(`[${tag}]   ${l.trim()}`));
    }
  }
}

// ══════════════════════════════════════════
// VALIDACIÓN DE CONFIGURACIÓN (FIX)
// ══════════════════════════════════════════

function validateProvider() {
  const missing = [];
  if (!PROVIDER.zapi.instanceId) missing.push('ZAPI_INSTANCE_ID');
  if (!PROVIDER.zapi.token) missing.push('ZAPI_TOKEN');

  if (missing.length > 0) {
    const errorMsg = `Faltan credenciales de Z-API: ${missing.join(', ')}. ` +
      `Configúralas en tu .env o en las variables de entorno.`;
    logError('BANCHECK', 'Configuración inválida', new Error(errorMsg));
    throw new Error(errorMsg);
  }
}

// ══════════════════════════════════════════
// LLAMADA A Z-API (CON TIMEOUT Y MANEJO DE ERRORES)
// ══════════════════════════════════════════

async function checkViaZapi(phone) {
  validateProvider(); // Lanza error si faltan credenciales

  const { baseUrl, instanceId, token, clientToken } = PROVIDER.zapi;
  // La documentación indica que se debe enviar ddi y phone por separado[reference:2].
  // Asumimos que el número viene en formato internacional limpio.
  const ddi = phone.substring(0, 2); // Ajusta esto según tu lógica de DDI
  const localNumber = phone.substring(2);

  const url = `${baseUrl}/instances/${instanceId}/token/${token}/mobile/registration-available`;
  log('BANCHECK-ZAPI', `POST ${url}`);
  log('BANCHECK-ZAPI', `DDI: ${ddi}, Phone: ${localNumber}`);

  const headers = { 'Content-Type': 'application/json' };
  if (clientToken) headers['Client-Token'] = clientToken;

  const body = JSON.stringify({ ddi, phone: localNumber }); // Formato correcto[reference:3]

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const rawText = await response.text();
    log('BANCHECK-ZAPI', `HTTP ${response.status}`);
    log('BANCHECK-ZAPI', `Response: ${rawText.substring(0, 500)}`);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error(`Respuesta no es JSON: ${rawText.substring(0, 200)}`);
    }

    return { httpStatus: response.status, data };

  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error(`TIMEOUT_ZAPI (${PROVIDER.timeoutMs}ms)`);
    }
    throw e;
  }
}

// ══════════════════════════════════════════
// API PRINCIPAL (CON INTERPRETACIÓN DE RESPUESTA)
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  const start = Date.now();
  log('BANCHECK', '════════════════════════════════════════');
  log('BANCHECK', `VERIFICANDO: ${phone}`);
  log('BANCHECK', `Proveedor: ${PROVIDER.name}`);
  log('BANCHECK', '════════════════════════════════════════');

  try {
    // 1. Validar configuración (si falla, devuelve error y no crashea)
    try {
      validateProvider();
    } catch (e) {
      return {
        status: 'ERROR',
        message: `❌ Configuración inválida: ${e.message}`,
        raw: { error: e.message },
      };
    }

    // 2. Limpiar número
    const cleanPhone = String(phone).replace(/\D/g, '');
    if (cleanPhone.length < 8) {
      return { status: 'ERROR', message: '❌ Número inválido', raw: { phone, cleanPhone } };
    }

    // 3. Llamar a Z-API
    const { httpStatus, data } = await checkViaZapi(cleanPhone);
    const elapsed = Date.now() - start;
    log('BANCHECK', `📊 HTTP ${httpStatus} en ${elapsed}ms`);

    // 4. Manejar error HTTP
    if (httpStatus >= 400) {
      logError('BANCHECK', `HTTP ${httpStatus}`, data);
      return {
        status: 'ERROR',
        message: `❌ Error HTTP ${httpStatus}: ${data.message || data.error || 'desconocido'}`,
        raw: { httpStatus, data, elapsedMs: elapsed },
      };
    }

    // 5. Interpretar respuesta de Z-API
    // Caso A: Número baneado (la respuesta incluye blocked: true y appealToken)[reference:4]
    if (data.blocked === true) {
      const appealToken = data.appealToken || '(no proporcionado)';
      log('BANCHECK', `❌ BANEADO. AppealToken: ${appealToken.substring(0, 20)}...`);
      return {
        status: 'PERMANENT_BAN',
        message: `❌ Cuenta baneada. Token de apelación: ${appealToken}`,
        raw: { blocked: true, appealToken, elapsedMs: elapsed },
      };
    }

    // Caso B: Número activo / disponible[reference:5]
    if (data.available === true) {
      log('BANCHECK', '✅ No baneado — Disponible para registro');
      return {
        status: 'ACTIVE',
        message: '✅ Cuenta activa (no baneada)',
        raw: { available: true, data, elapsedMs: elapsed },
      };
    }

    // Caso C: Formato desconocido
    log('BANCHECK', `⚠️ Formato desconocido: ${JSON.stringify(data)}`);
    return {
      status: 'UNKNOWN',
      message: `❓ Respuesta desconocida: ${JSON.stringify(data).substring(0, 200)}`,
      raw: { data, elapsedMs: elapsed },
    };

  } catch (e) {
    logError('BANCHECK', 'Error inesperado', e);
    return {
      status: 'ERROR',
      message: `❌ Error: ${e.message}`,
      raw: { error: e.message, elapsedMs: Date.now() - start },
    };
  }
}

// ══════════════════════════════════════════
// FUNCIONES DE COMPATIBILIDAD (NO-OP)
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  log('BANCHECK', 'Inicializando módulo de ban check (sin cliente local)');
  try {
    validateProvider();
    log('BANCHECK', `✅ Proveedor: ${PROVIDER.name}`);
    isReady = true;
    return true;
  } catch (e) {
    logError('BANCHECK', 'Error de configuración', e);
    isReady = false;
    return false;
  }
}

function isReadyFn() {
  return isReady;
}

function getDiagnostics() {
  return {
    provider: PROVIDER.name,
    ready: isReady,
    config: {
      instanceId: PROVIDER.zapi.instanceId ? '✅' : '❌',
      token: PROVIDER.zapi.token ? '✅' : '❌',
    },
  };
}

async function destroyClient() {
  isReady = false;
}

// ══════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════

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
  getStats: () => ({ provider: PROVIDER.name }),
  hasSession: () => false,
  destroyClient,
  isNumberBanned: async (phone) => {
    const r = await checkNumberStatus(phone);
    return r.status === 'PERMANENT_BAN';
  },
  emitter: {
    on: () => {},
    emit: () => {},
    once: () => {},
  },
};
