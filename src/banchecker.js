/**
 * MÓDULO DE VERIFICACIÓN DE BAN
 * Usa el endpoint de registro de WhatsApp Business API
 * Compatible con Z-API y cualquier proveedor que exponga:
 *   POST /instances/{instanceId}/token/{token}/mobile/registration-available
 * 
 * Devuelve: { banned, reason, appeal_token, violation_type }
 */

const config = require('./config');
const { dbg } = config;

// ══════════════════════════════════════════
// CONFIGURACIÓN DEL PROVEEDOR
// ══════════════════════════════════════════

const PROVIDER = {
  // Z-API por defecto. Cambia si usas otro.
  name: process.env.BANCHECK_PROVIDER || 'zapi',

  // Z-API
  zapi: {
    baseUrl: 'https://api.z-api.io',
    instanceId: process.env.ZAPI_INSTANCE_ID || '',
    token: process.env.ZAPI_TOKEN || '',
    clientToken: process.env.ZAPI_CLIENT_TOKEN || '',
  },

  // Endpoint genérico (para otros proveedores)
  generic: {
    url: process.env.BANCHECK_URL || '',
    apiKey: process.env.BANCHECK_API_KEY || '',
    method: 'POST',
  },

  // Timeout
  timeoutMs: 30000,
};

// ══════════════════════════════════════════
// VERIFICAR CONFIGURACIÓN
// ══════════════════════════════════════════

function validateProvider() {
  if (PROVIDER.name === 'zapi') {
    if (!PROVIDER.zapi.instanceId || !PROVIDER.zapi.token) {
      throw new Error('ZAPI_INSTANCE_ID y ZAPI_TOKEN son requeridos para usar Z-API');
    }
  } else if (PROVIDER.name === 'generic') {
    if (!PROVIDER.generic.url) {
      throw new Error('BANCHECK_URL es requerido para el proveedor genérico');
    }
  }
}

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
    if (err.message) console.error(`[${tag}]   message: ${err.message}`);
    if (err.stack) {
      err.stack.split('\n').slice(0, 5).forEach(l => console.error(`[${tag}]   ${l.trim()}`));
    }
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
      const err = new Error(`TIMEOUT_${label} (${ms}ms)`);
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
// LLAMADA A Z-API
// ══════════════════════════════════════════

async function checkViaZapi(phone) {
  const { baseUrl, instanceId, token, clientToken } = PROVIDER.zapi;

  const url = `${baseUrl}/instances/${instanceId}/token/${token}/mobile/registration-available`;

  log('BANCHECK-ZAPI', `POST ${url}`);
  log('BANCHECK-ZAPI', `Phone: ${phone}`);

  const headers = {
    'Content-Type': 'application/json',
  };
  if (clientToken) headers['Client-Token'] = clientToken;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone }),
  });

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
}

// ══════════════════════════════════════════
// LLAMADA A PROVEEDOR GENÉRICO
// ══════════════════════════════════════════

async function checkViaGeneric(phone) {
  const { url, apiKey, method } = PROVIDER.generic;

  log('BANCHECK-GENERIC', `${method} ${url}`);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const response = await fetch(url, {
    method,
    headers,
    body: JSON.stringify({ phone }),
  });

  const rawText = await response.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`Respuesta no es JSON: ${rawText.substring(0, 200)}`);
  }

  return { httpStatus: response.status, data };
}

// ══════════════════════════════════════════
// API PRINCIPAL
// ══════════════════════════════════════════

/**
 * Consulta el estado de ban de cualquier número de WhatsApp.
 * @param {string} phone - Número en formato internacional (ej: "51999999999")
 * @returns {Promise<object>} { status, message, raw }
 */
async function checkNumberStatus(phone) {
  const start = Date.now();

  log('BANCHECK', '════════════════════════════════════════');
  log('BANCHECK', `VERIFICANDO: ${phone}`);
  log('BANCHECK', `Proveedor: ${PROVIDER.name}`);
  log('BANCHECK', '════════════════════════════════════════');

  try {
    validateProvider();
  } catch (e) {
    logError('BANCHECK', 'Configuración inválida', e);
    return {
      status: 'ERROR',
      message: `❌ Configuración inválida: ${e.message}`,
      raw: { error: e.message },
    };
  }

  // Limpiar número (solo dígitos)
  const cleanPhone = String(phone).replace(/\D/g, '');

  if (cleanPhone.length < 8) {
    return {
      status: 'ERROR',
      message: '❌ Número inválido (muy corto)',
      raw: { phone, cleanPhone },
    };
  }

  try {
    let result;

    if (PROVIDER.name === 'zapi') {
      result = await withTimeout(checkViaZapi(cleanPhone), PROVIDER.timeoutMs, 'zapi');
    } else if (PROVIDER.name === 'generic') {
      result = await withTimeout(checkViaGeneric(cleanPhone), PROVIDER.timeoutMs, 'generic');
    } else {
      throw new Error(`Proveedor desconocido: ${PROVIDER.name}`);
    }

    const elapsed = Date.now() - start;
    const { httpStatus, data } = result;

    log('BANCHECK', `📊 HTTP ${httpStatus} en ${elapsed}ms`);

    // ══════════════════════════════════════════
    // INTERPRETAR RESPUESTA
    // ══════════════════════════════════════════

    // Error HTTP
    if (httpStatus >= 400) {
      logError('BANCHECK', `HTTP ${httpStatus}: ${JSON.stringify(data)}`);
      return {
        status: 'ERROR',
        message: `❌ Error HTTP ${httpStatus}: ${data.message || data.error || 'desconocido'}`,
        raw: { httpStatus, data, elapsedMs: elapsed },
      };
    }

    // Formato esperado de Z-API / Meta:
    // {
    //   "banned": true,
    //   "reason": "WhatsApp misuse",
    //   "details": {
    //     "appeal_token": "...",
    //     "login": "5215550555555",
    //     "status": "fail",
    //     "violation_type": "21"
    //   }
    // }
    // O si está OK:
    // {
    //   "banned": false,
    //   "available": true
    // }

    // CASO 1: Number está BANEADO
    if (data.banned === true || data.blocked === true) {
      const reason = data.reason || data.details?.reason || 'Violación de políticas';
      const violationType = data.details?.violation_type || 'desconocido';
      const appealToken = data.details?.appeal_token || null;
      const login = data.details?.login || cleanPhone;

      log('BANCHECK', `❌ BANEADO — Razón: ${reason} — Violación: ${violationType}`);

      // Interpretar tipo de violación
      let banType = 'PERMANENT_BAN';
      if (violationType === '21' || reason.toLowerCase().includes('misuse')) {
        banType = 'PERMANENT_BAN';
      } else if (reason.toLowerCase().includes('spam')) {
        banType = 'SPAM_BAN';
      } else if (reason.toLowerCase().includes('review') || reason.toLowerCase().includes('temporal')) {
        banType = 'TEMPORARY_BAN';
      }

      return {
        status: banType,
        message: `❌ Cuenta baneada: ${reason}`,
        raw: {
          banned: true,
          reason,
          violationType,
          appealToken,
          login,
          elapsedMs: elapsed,
        },
      };
    }

    // CASO 2: Number está disponible (no baneado)
    if (data.banned === false || data.available === true || data.status === 'success') {
      log('BANCHECK', `✅ No baneado — Disponible para registro`);
      return {
        status: 'ACTIVE',
        message: '✅ Cuenta activa (no baneada)',
        raw: { banned: false, data, elapsedMs: elapsed },
      };
    }

    // CASO 3: Formato desconocido
    log('BANCHECK', `⚠️ Formato desconocido: ${JSON.stringify(data)}`);
    return {
      status: 'UNKNOWN',
      message: `❓ Respuesta desconocida: ${JSON.stringify(data).substring(0, 200)}`,
      raw: { data, elapsedMs: elapsed },
    };

  } catch (e) {
    logError('BANCHECK', 'Error', e);
    return {
      status: 'ERROR',
      message: `❌ Error: ${e.message}`,
      raw: { error: e.message, elapsedMs: Date.now() - start },
    };
  }
}

/**
 * Mantener compatibilidad: algunos módulos llaman a initializeWhatsApp
 * Ahora es un no-op porque no hay cliente local.
 */
async function initializeWhatsApp() {
  log('BANCHECK', 'Inicializando módulo de ban check (sin cliente local)');
  validateProvider();
  log('BANCHECK', `✅ Proveedor: ${PROVIDER.name}`);
  return true;
}

async function destroyClient() {
  // No-op
}

function isReady() {
  try {
    validateProvider();
    return true;
  } catch (e) {
    return false;
  }
}

function getDiagnostics() {
  return {
    provider: PROVIDER.name,
    ready: isReady(),
    config: PROVIDER.name === 'zapi'
      ? { instanceId: PROVIDER.zapi.instanceId ? '✅' : '❌', token: PROVIDER.zapi.token ? '✅' : '❌' }
      : { url: PROVIDER.generic.url ? '✅' : '❌' },
  };
}

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = {
  checkNumberStatus,
  initializeWhatsApp,
  destroyClient,
  isReady,
  getDiagnostics,
  // Stubs para compatibilidad con bot.js / monitor.js / index.js
  getClient: () => null,
  getQR: () => null,
  getQRBuffer: () => null,
  hasQR: () => false,
  clearQR: () => {},
  getStats: () => ({ provider: PROVIDER.name }),
  hasSession: () => false,
  restartForQR: async () => { throw new Error('No aplica con API de ban check'); },
  reconnect: async () => { return true; },
  getReadyClient: async () => null,
  isNumberBanned: async (phone) => {
    const r = await checkNumberStatus(phone);
    return r.status === 'PERMANENT_BAN' || r.status === 'SPAM_BAN' || r.status === 'TEMPORARY_BAN';
  },
  emitter: {
    on: () => {},
    emit: () => {},
    once: () => {},
  },
};
