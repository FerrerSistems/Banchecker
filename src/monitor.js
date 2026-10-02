/**
 * SISTEMA DE MONITOREO
 * Escanea números cada 60 segundos y notifica cambios
 */

const config = require('./config');
const { dbg } = config;
const whatsapp = require('./whatsapp');
const github = require('./github');

// ══════════════════════════════════════════
// ESTADO DEL MONITOR
// ══════════════════════════════════════════

let monitorInterval = null;
let isRunning = false;
let botInstance = null;

const monitorCache = new Map();

// ══════════════════════════════════════════
// INICIAR MONITOR
// ══════════════════════════════════════════

async function startMonitor(telegramBot) {
  if (isRunning) {
    dbg('MONITOR', '⚠️ Monitor ya está corriendo');
    return;
  }

  botInstance = telegramBot;
  isRunning = true;

  dbg('MONITOR', `Iniciando monitor (intervalo: ${config.monitor.intervalMs}ms)`);

  await refreshMonitorCache();
  await runMonitorCycle();

  monitorInterval = setInterval(async () => {
    await runMonitorCycle();
  }, config.monitor.intervalMs);

  dbg('MONITOR', '✅ Monitor iniciado');
}

// ══════════════════════════════════════════
// DETENER MONITOR
// ══════════════════════════════════════════

function stopMonitor() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  isRunning = false;
  dbg('MONITOR', '⏹️ Monitor detenido');
}

// ══════════════════════════════════════════
// REFRESCAR CACHÉ
// ══════════════════════════════════════════

async function refreshMonitorCache() {
  try {
    const files = await github.listLogsFiles();
    const monitorFiles = files.filter(f => f.startsWith('monitor_') && f.endsWith('.json'));

    for (const file of monitorFiles) {
      const userId = file.replace('monitor_', '').replace('.json', '');
      const data = await github.readJson(file, { userId, numbers: [] }, false);
      const numbers = data.numbers || [];
      monitorCache.set(userId, new Set(numbers));
    }

    dbg('MONITOR', `Caché actualizado: ${monitorCache.size} usuarios`);
  } catch (e) {
    dbg('MONITOR', `❌ Error refrescando caché: ${e.message}`);
  }
}

// ══════════════════════════════════════════
// CICLO DE MONITOREO
// ══════════════════════════════════════════

async function runMonitorCycle() {
  dbg('MONITOR', '🔄 Ejecutando ciclo...');

  try {
    const suspendedData = await github.getSuspendedNumbers();
    const suspendedSet = new Set(suspendedData.numbers || []);

    const authData = await github.getAuthorizedUsers();
    const authorizedUsers = Object.keys(authData.users || {});

    await refreshMonitorCache();

    for (const userId of authorizedUsers) {
      const numbers = monitorCache.get(userId);
      if (!numbers || numbers.size === 0) continue;

      for (const phone of numbers) {
        if (suspendedSet.has(phone)) {
          dbg('MONITOR', `⏭️ ${phone} ya suspendido, saltando`);
          continue;
        }

        try {
          const result = await whatsapp.checkNumberStatus(phone);
          dbg('MONITOR', `📊 ${phone} → ${result.status}`);

          if (result.status !== 'ACTIVE' && result.status !== 'VERIFY') {
            suspendedData.numbers.push(phone);
            suspendedSet.add(phone);
            await github.setSuspendedNumbers(suspendedData);

            numbers.delete(phone);
            monitorCache.set(userId, numbers);
            await github.setUserMonitorList(userId, {
              userId,
              numbers: Array.from(numbers),
            });

            await notifyUser(userId, phone, result);

            const freshSuspended = await github.getSuspendedNumbers();
            suspendedSet.clear();
            (freshSuspended.numbers || []).forEach(n => suspendedSet.add(n));

            dbg('MONITOR', `🚫 ${phone} baneado y notificado a ${userId}`);
          }
        } catch (e) {
          dbg('MONITOR', `❌ Error verificando ${phone}: ${e.message}`);
        }

        await sleep(500);
      }
    }

    dbg('MONITOR', '✅ Ciclo completado');
  } catch (e) {
    dbg('MONITOR', `❌ Error en ciclo: ${e.message}`);
  }
}

// ══════════════════════════════════════════
// NOTIFICAR AL USUARIO
// ══════════════════════════════════════════

async function notifyUser(userId, phone, result) {
  if (!botInstance) {
    dbg('MONITOR', '⚠️ No hay bot para notificar');
    return;
  }

  const message = [
    '🚨 *ALERTA DE BANEO* 🚨',
    '',
    `📱 *Número:* \`+${phone}\``,
    `📊 *Estado:* ${result.message}`,
    `🔍 *Detalles:* ${result.raw?.error || result.raw?.name || 'Sin detalles'}`,
    '',
    `⏰ *Fecha:* ${new Date().toLocaleString('es-ES')}`,
    '',
    '❌ Este número ha sido *eliminado* de tu lista de monitoreo.',
    '💡 Ya no se volverá a monitorear.',
  ].join('\n');

  try {
    await botInstance.telegram.sendMessage(userId, message, {
      parse_mode: 'Markdown',
    });
    dbg('MONITOR', `📨 Notificación enviada a ${userId}`);
  } catch (e) {
    dbg('MONITOR', `❌ Error enviando a ${userId}: ${e.message}`);
  }
}

// ══════════════════════════════════════════
// UTILIDADES
// ══════════════════════════════════════════

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ══════════════════════════════════════════
// AGREGAR NÚMERO
// ══════════════════════════════════════════

async function addNumberToMonitor(userId, phone) {
  const data = await github.getUserMonitorList(userId);
  const numbers = data.numbers || [];

  if (numbers.includes(phone)) {
    return { success: false, reason: 'already_exists' };
  }

  const suspended = await github.getSuspendedNumbers();
  if ((suspended.numbers || []).includes(phone)) {
    return { success: false, reason: 'already_suspended' };
  }

  numbers.push(phone);
  await github.setUserMonitorList(userId, { userId, numbers });

  monitorCache.set(userId, new Set(numbers));

  dbg('MONITOR', `➕ ${phone} agregado al monitor de ${userId}`);
  return { success: true };
}

// ══════════════════════════════════════════
// ELIMINAR NÚMERO
// ══════════════════════════════════════════

async function removeNumberFromMonitor(userId, phone) {
  const data = await github.getUserMonitorList(userId);
  const numbers = data.numbers || [];

  const index = numbers.indexOf(phone);
  if (index === -1) {
    return { success: false, reason: 'not_found' };
  }

  numbers.splice(index, 1);
  await github.setUserMonitorList(userId, { userId, numbers });
  monitorCache.set(userId, new Set(numbers));

  dbg('MONITOR', `➖ ${phone} eliminado del monitor de ${userId}`);
  return { success: true };
}

// ══════════════════════════════════════════
// OBTENER LISTAS
// ══════════════════════════════════════════

async function getUserMonitoredNumbers(userId) {
  const data = await github.getUserMonitorList(userId);
  return data.numbers || [];
}

async function getUserSuspendedNumbers(userId) {
  const allSuspended = await github.getSuspendedNumbers();
  return allSuspended.numbers || [];
}

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = {
  startMonitor,
  stopMonitor,
  runMonitorCycle,
  refreshMonitorCache,
  addNumberToMonitor,
  removeNumberFromMonitor,
  getUserMonitoredNumbers,
  getUserSuspendedNumbers,
  getMonitorCache: () => monitorCache,
};
