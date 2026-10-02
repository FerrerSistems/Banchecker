/**
 * MÓDULO DE QR
 * Genera imágenes del QR y las envía al admin por Telegram
 */

const QRCode = require('qrcode');
const config = require('./config');
const { dbg } = config;

// Estado del QR actual
let currentQR = null;
let currentQRBuffer = null;
let currentQRTime = null;

/**
 * Genera la imagen del QR y la guarda en memoria
 */
async function generateQRImage(qrString) {
  try {
    const buffer = await QRCode.toBuffer(qrString, {
      type: 'png',
      width: 600,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
    });

    currentQR = qrString;
    currentQRBuffer = buffer;
    currentQRTime = new Date();

    dbg('QR', `Imagen generada (${(buffer.length / 1024).toFixed(1)} KB)`);
    return buffer;
  } catch (e) {
    dbg('QR', `❌ Error generando imagen: ${e.message}`);
    throw e;
  }
}

/**
 * Envía el QR al admin por Telegram
 */
async function sendQRToAdmin(bot, qrString) {
  if (!bot) {
    dbg('QR', '⚠️ No hay bot de Telegram para enviar QR');
    return false;
  }

  if (!config.telegram.adminId) {
    dbg('QR', '⚠️ No hay admin configurado');
    return false;
  }

  try {
    const buffer = await generateQRImage(qrString);

    const caption = [
      '📲 *NUEVO CÓDIGO QR*',
      '',
      '🔐 Escanea este código con WhatsApp para vincular la sesión del bot:',
      '',
      '1️⃣ Abre WhatsApp en tu celular',
      '2️⃣ Ve a *Ajustes → Dispositivos vinculados*',
      '3️⃣ Toca *Vincular un dispositivo*',
      '4️⃣ Escanea el código de la imagen',
      '',
      `⏰ Generado: ${new Date().toLocaleString('es-ES')}`,
      '',
      '⚠️ Este QR expira en ~20 segundos. Si expira, usa /session para regenerarlo.',
    ].join('\n');

    await bot.telegram.sendPhoto(
      config.telegram.adminId,
      { source: buffer },
      {
        caption,
        parse_mode: 'Markdown',
      }
    );

    dbg('QR', '✅ QR enviado al admin por Telegram');
    return true;
  } catch (e) {
    dbg('QR', `❌ Error enviando QR: ${e.message}`);
    return false;
  }
}

/**
 * Obtiene el QR actual (buffer PNG)
 */
function getCurrentQRBuffer() {
  return currentQRBuffer;
}

/**
 * Obtiene el string del QR actual
 */
function getCurrentQR() {
  return currentQR;
}

/**
 * Obtiene la hora de generación del QR
 */
function getCurrentQRTime() {
  return currentQRTime;
}

/**
 * Verifica si hay un QR pendiente
 */
function hasQR() {
  return currentQRBuffer !== null;
}

/**
 * Limpia el QR actual (después de autenticar)
 */
function clearQR() {
  currentQR = null;
  currentQRBuffer = null;
  currentQRTime = null;
  dbg('QR', 'QR limpiado');
}

module.exports = {
  generateQRImage,
  sendQRToAdmin,
  getCurrentQRBuffer,
  getCurrentQR,
  getCurrentQRTime,
  hasQR,
  clearQR,
};
