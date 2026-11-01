const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const emitter = new EventEmitter();
let isReady = false;
let sock = null;

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ══════════════════════════════════════════
// FUNCIÓN PRINCIPAL DE VERIFICACIÓN
// ══════════════════════════════════════════

async function checkNumberStatus(phone) {
  log('CHECK', `════════════════════════════════════════`);
  log('CHECK', `VERIFICANDO POR PAIRING CODE: ${phone}`);
  log('CHECK', `════════════════════════════════════════`);

  const cleanPhone = String(phone).replace(/\D/g, '');

  // Carpeta temporal para la sesión de sondeo (se borra después)
  const tempSessionPath = path.join(config.whatsapp.sessionPath, `temp_${cleanPhone}_${Date.now()}`);
  
  try {
    // 1. Crear un estado de autenticación temporal (vacío)
    if (!fs.existsSync(tempSessionPath)) fs.mkdirSync(tempSessionPath, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(tempSessionPath);

    // 2. Crear un socket temporal
    const tempSock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: false,
    });

    tempSock.ev.on('creds.update', saveCreds);

    // 3. Solicitar el código de emparejamiento
    log('CHECK', `Solicitando pairing code a WhatsApp para ${cleanPhone}...`);
    
    // El código se genera o lanza error
    const code = await tempSock.requestPairingCode(cleanPhone);

    // 4. Si llega aquí, WhatsApp generó el código (El número está ACTIVO)
    log('CHECK', `✅ CÓDIGO GENERADO: ${code}. El número NO está baneado.`);

    // Cerrar la sesión temporal
    try { tempSock.end(undefined); } catch (e) {}
    // Borrar la carpeta temporal
    try { fs.rmSync(tempSessionPath, { recursive: true, force: true }); } catch (e) {}

    return {
      status: 'ACTIVE',
      message: '✅ Número activo (código generado con éxito)',
      raw: { code, method: 'pairing_code' }
    };

  } catch (error) {
    // 5. Si hay error, analizamos el mensaje
    const errMsg = (error.message || '').toLowerCase();
    log('CHECK', `❌ Error de WhatsApp: ${error.message}`);

    // Limpiar sesión temporal
    try { fs.rmSync(tempSessionPath, { recursive: true, force: true }); } catch (e) {}

    // Clasificar el error
    if (errMsg.includes('forbidden') || errMsg.includes('banned') || errMsg.includes('blocked')) {
      return {
        status: 'PERMANENT_BAN',
        message: '❌ Cuenta suspendida o baneada por WhatsApp',
        raw: { error: error.message, method: 'pairing_code' }
      };
    }

    if (errMsg.includes('not on whatsapp') || errMsg.includes('invalid number')) {
      return {
        status: 'PERMANENT_BAN',
        message: '❌ No está registrado en WhatsApp',
        raw: { error: error.message, method: 'pairing_code' }
      };
    }

    if (errMsg.includes('too many') || errMsg.includes('rate') || errMsg.includes('limit')) {
      return {
        status: 'ERROR',
        message: '⚠️ Límite de consultas alcanzado. Espera unos minutos.',
        raw: { error: error.message, method: 'pairing_code' }
      };
    }

    // Error desconocido
    return {
      status: 'ERROR',
      message: `❓ Error desconocido: ${error.message}`,
      raw: { error: error.message, method: 'pairing_code' }
    };
  }
}

// ══════════════════════════════════════════
// STUBS DE COMPATIBILIDAD
// (Para que el bot de Telegram no falle)
// ══════════════════════════════════════════

async function initializeWhatsApp() {
  log('WHATSAPP', 'Módulo de verificación por pairing code inicializado.');
  // Creamos una sesión fantasma solo para mantener el bot "listo"
  const mainSessionPath = config.whatsapp.sessionPath;
  if (!fs.existsSync(mainSessionPath)) fs.mkdirSync(mainSessionPath, { recursive: true });
  
  // Baileys no necesita un cliente persistente para consultar
  isReady = true; 
  return true;
}

function getDiagnostics() {
  return { provider: 'baileys_pairing_code', ready: isReady };
}

function isReadyFn() { return isReady; }
function getClient() { return null; }
function getQR() { return null; }
function getQRBuffer() { return null; }
function hasQR() { return false; }
function clearQR() {}
function getStats() { return {}; }
function hasSession() { return false; }
async function destroyClient() { isReady = false; }

module.exports = {
  initializeWhatsApp,
  checkNumberStatus,
  destroyClient,
  isReady: isReadyFn,
  getClient,
  getQR,
  getQRBuffer,
  hasQR,
  clearQR,
  getDiagnostics,
  getStats,
  hasSession,
  isNumberBanned: async (phone) => {
    const r = await checkNumberStatus(phone);
    return ['PERMANENT_BAN', 'TEMPORARY_BAN', 'SPAM_BAN'].includes(r.status);
  },
  emitter,
};
