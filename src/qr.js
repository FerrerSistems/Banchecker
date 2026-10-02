/**
 * MÓDULO DE QR
 * Genera imágenes PNG del QR con reintentos y fallbacks
 * Cachea el QR actual para poder reenviarlo desde /session
 */

const QRCode = require('qrcode');
const config = require('./config');
const { dbg } = config;

// ══════════════════════════════════════════
// ESTADO GLOBAL DEL QR
// ══════════════════════════════════════════

let currentQR = null;
let currentQRBuffer = null;
let currentQRTime = null;
let lastSentTime = null;
let sendAttempts = 0;
let lastSendError = null;

// Opciones de la imagen
const QR_OPTIONS = {
  type: 'png',
  width: 600,
  margin: 2,
  errorCorrectionLevel: 'M',
  color: {
    dark: '#000000',
    light: '#FFFFFF',
  },
};

// ══════════════════════════════════════════
// GENERAR IMAGEN DEL QR
// ══════════════════════════════════════════

/**
 * Genera un buffer PNG a partir del string del QR.
 * @param {string} qrString - El texto del QR
 * @returns {Promise<Buffer>} Buffer PNG
 */
async function generateQRImage(qrString) {
  console.log('[QR] ═══ Generando imagen PNG ═══');

  if (!qrString || typeof qrString !== 'string') {
    throw new Error('QR string inválido');
  }

  console.log(`[QR] Longitud del string: ${qrString.length}`);

  try {
    const buffer = await QRCode.toBuffer(qrString, QR_OPTIONS);

    if (!buffer || buffer.length === 0) {
      throw new Error('QRCode.toBuffer devolvió buffer vacío');
    }

    // Guardar en memoria
    currentQR = qrString;
    currentQRBuffer = buffer;
    currentQRTime = new Date();

    const sizeKB = (buffer.length / 1024).toFixed(1);
    console.log(`[QR] ✅ Imagen generada: ${sizeKB} KB`);

    return buffer;
  } catch (e) {
    console.error(`[QR] ❌ Error generando imagen: ${e.message}`);
    console.error(e.stack);
    throw new Error(`No se pudo generar la imagen QR: ${e.message}`);
  }
}

// ══════════════════════════════════════════
// ENVIAR QR AL ADMIN
// ══════════════════════════════════════════

/**
 * Envía el QR al admin por Telegram con reintentos.
 * @param {Telegram} bot - Instancia del bot de Telegraf
 * @param {string} qrString - El string del QR
 * @param {number} maxRetries - Número máximo de intentos
 * @returns {Promise<boolean>}
 */
async function sendQRToAdmin(bot, qrString, maxRetries = 3) {
  console.log('\n[QR] ═══ sendQRToAdmin() ═══');

  // Validaciones previas
  if (!bot || !bot.telegram) {
    console.error('[QR] ❌ Bot inválido');
    lastSendError = 'Bot de Telegram no disponible';
    return false;
  }

  if (!config.telegram.adminId) {
    console.error('[QR] ❌ No hay admin ID configurado');
    lastSendError = 'Admin ID no configurado';
    return false;
  }

  if (!qrString) {
    console.error('[QR] ❌ No hay QR string');
    lastSendError = 'QR string vacío';
    return false;
  }

  // Generar la imagen (si falla, no seguimos)
  let buffer;
  try {
    buffer = await generateQRImage(qrString);
  } catch (e) {
    console.error(`[QR] ❌ No se pudo generar imagen: ${e.message}`);
    lastSendError = e.message;

    // Fallback: enviar el string como texto
    try {
      console.log('[QR] Intentando enviar QR como texto (fallback)...');
      await bot.telegram.sendMessage(
        config.telegram.adminId,
        `⚠️ <b>No se pudo generar la imagen del QR</b>\n\n` +
        `Error: <code>${escapeHtml(e.message)}</code>\n\n` +
        `💡 Usa <code>/session</code> de nuevo en unos segundos.`,
        { parse_mode: 'HTML' }
      );
      return false;
    } catch (e2) {
      console.error(`[QR] ❌ Fallback también falló: ${e2.message}`);
      return false;
    }
  }

  // Caption del mensaje
  const caption =
    '📲 <b>NUEVO CÓDIGO QR</b>\n\n' +
    '<b>Escanea con WhatsApp:</b>\n' +
    '1️⃣ Abre WhatsApp en tu celular\n' +
    '2️⃣ Ajustes → Dispositivos vinculados\n' +
    '3️⃣ Vincular un dispositivo\n' +
    '4️⃣ Escanea esta imagen\n\n' +
    `⏰ Generado: ${new Date().toLocaleString('es-ES')}\n\n` +
    `⚠️ El QR expira en ~20 segundos.\n` +
    `Si expira, usa /session para regenerarlo.`;

  // ══════════════════════════════════════════
  // REINTENTOS
  // ══════════════════════════════════════════
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    sendAttempts++;
    console.log(`[QR] Intento #${attempt}/${maxRetries}...`);

    try {
      await bot.telegram.sendPhoto(
        config.telegram.adminId,
        { source: buffer },
        {
          caption,
          parse_mode: 'HTML',
          // Esperar a que se suba completamente
          filename: 'whatsapp_qr.png',
        }
      );

      lastSentTime = new Date();
      lastSendError = null;
      console.log(`[QR] ✅ QR enviado al admin (intento #${attempt})\n`);
      return true;
    } catch (e) {
      console.error(`[QR] ❌ Intento #${attempt} falló: ${e.message}`);

      // Errores específicos de Telegram
      const errMsg = String(e.message || '').toLowerCase();

      if (errMsg.includes('chat not found') || errMsg.includes('user not found')) {
        console.error('[QR] ❌ El admin no ha iniciado chat con el bot');
        console.error('[QR] 💡 Abre Telegram y envía /start al bot');
        lastSendError = 'El admin no ha iniciado el bot. Envía /start';
        return false; // No reintentar
      }

      if (errMsg.includes('blocked')) {
        console.error('[QR] ❌ El admin bloqueó al bot');
        lastSendError = 'El admin bloqueó al bot';
        return false;
      }

      if (errMsg.includes('too large') || errMsg.includes('file is too big')) {
        console.error('[QR] ❌ Imagen demasiado grande');
        lastSendError = 'Imagen demasiado grande';
        return false;
      }

      if (errMsg.includes('parse') || errMsg.includes("can't parse")) {
        console.error('[QR] ❌ Error parseando HTML, reintentando sin parse_mode...');
        try {
          await bot.telegram.sendPhoto(
            config.telegram.adminId,
            { source: buffer },
            { caption: caption.replace(/<[^>]*>/g, '') } // Sin HTML
          );
          console.log('[QR] ✅ Enviado sin HTML');
          return true;
        } catch (e2) {
          console.error(`[QR] ❌ Fallback sin HTML también falló: ${e2.message}`);
        }
      }

      // Si es el último intento, guardar error
      if (attempt === maxRetries) {
        lastSendError = e.message;
        console.error(`[QR] ❌ Todos los intentos fallaron. Último error: ${e.message}`);
        console.error(e.stack);

        // Fallback final: enviar como documento
        try {
          console.log('[QR] Intentando enviar como documento...');
          await bot.telegram.sendDocument(
            config.telegram.adminId,
            { source: buffer, filename: 'whatsapp_qr.png' },
            { caption: '📲 QR (enviado como documento)' }
          );
          console.log('[QR] ✅ Enviado como documento');
          return true;
        } catch (e2) {
          console.error(`[QR] ❌ Fallback documento también falló: ${e2.message}`);
        }

        return false;
      }

      // Esperar antes de reintentar (backoff exponencial)
      const waitMs = 1000 * attempt;
      console.log(`[QR] ⏳ Esperando ${waitMs}ms antes de reintentar...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  return false;
}

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ══════════════════════════════════════════
// GETTERS
// ══════════════════════════════════════════

function getCurrentQRBuffer() {
  return currentQRBuffer;
}

function getCurrentQR() {
  return currentQR;
}

function getCurrentQRTime() {
  return currentQRTime;
}

function hasQR() {
  return currentQRBuffer !== null;
}

function getQRDiagnostics() {
  return {
    hasQR: !!currentQRBuffer,
    qrLength: currentQR?.length || 0,
    generatedAt: currentQRTime?.toISOString() || null,
    lastSentAt: lastSentTime?.toISOString() || null,
    sendAttempts,
    lastError: lastSendError,
    bufferSizeKB: currentQRBuffer ? (currentQRBuffer.length / 1024).toFixed(1) : 0,
  };
}

// ══════════════════════════════════════════
// LIMPIAR
// ══════════════════════════════════════════

function clearQR() {
  currentQR = null;
  currentQRBuffer = null;
  currentQRTime = null;
  console.log('[QR] QR limpiado de memoria');
}

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = {
  generateQRImage,
  sendQRToAdmin,
  getCurrentQRBuffer,
  getCurrentQR,
  getCurrentQRTime,
  hasQR,
  clearQR,
  getQRDiagnostics,
};
