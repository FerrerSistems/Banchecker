/**
 * SISTEMA DE MONITOREO
 * - Intervalo aleatorio entre 5 y 10 minutos (evita patrones detectables)
 * - Rate limiting global
 * - Jitter por número
 * - Full debug
 */

const config = require('./config');
const { dbg } = config;
const whatsapp = require('./whatsapp');
const github = require('./github');

// ══════════════════════════════════════════
// CONFIGURACIÓN
// ══════════════════════════════════════════

const CONFIG = {
  // Intervalo entre ciclos (aleatorio entre 5 y 10 minutos)
  INTERVAL_MIN_MS: 5 * 60 * 1000,   // 5 min
  INTERVAL_MAX_MS: 10 * 60 * 1000,  // 10 min

  // Pausa entre cada número dentro de un ciclo (aleatorio 30-60s)
  PER_NUMBER_MIN_MS: 30 * 1000,     // 30s
  PER_NUMBER_MAX_MS: 60 * 1000,     // 60s

  // Horario activo (hora local del servidor)
  ACTIVE_HOURS_START: 7,             // 7 AM
  ACTIVE_HOURS_END: 23,              // 11 PM

  // Cooldown por número (si ya se consultó en los últimos X min, saltar)
  PER_NUMBER_COOLDOWN_MS: 4 * 60 * 1000, // 4 min
};

// ══════════════════════════════════════════
// ESTADO
// ══════════════════════════════════════════

let monitorTimeout = null;
let isRunning = false;
let botInstance = null;
let currentCycleNumber = 0;

const monitorCache = new Map();
const lastCheckByNumber = new Map(); // phone → timestamp

// Stats
const stats = {
  cyclesRun: 0,
  totalChecks: 0,
  bannedDetected: 0,
  skipped: 0,
  errors: 0,
  startTime: Date.now(),
};

// ══════════════════════════════════════════
// UTILIDADES
// ══════════════════════════════════════════

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Delay aleatorio entre min y max
 */
function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Formatear ms a string legible
 */
function formatMs(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
}

/**
 * ¿Estamos en horario activo?
 */
function isActiveHour() {
  const hour = new Date().getHours();
  const active = hour >= CONFIG.ACTIVE_HOURS_START && hour < CONFIG.ACTIVE_HOURS_END;
  return active;
}

/**
 * ¿Se puede verificar este número ahora? (cooldown)
 */
function canCheckNumber(phone) {
  const last = lastCheckByNumber.get(phone);
  if (!last) return true;
  return (Date.now() - last) >= CONFIG.PER_NUMBER_COOLDOWN_MS;
}

/**
 * Marcar número como verificado ahora
 */
function markNumberChecked(phone) {
  lastCheckByNumber.set(phone, Date.now());

  // Limpieza periódica
  if (lastCheckByNumber.size > 5000) {
    const cutoff = Date.now() - 60 * 60 * 1000; // 1h
    for (const [k, v] of lastCheckByNumber.entries()) {
      if (v < cutoff) lastCheckByNumber.delete(k);
    }
  }
}

// ══════════════════════════════════════════
// START MONITOR
// ══════════════════════════════════════════

async function startMonitor(telegramBot) {
  if (isRunning) {
    dbg('MONITOR', '⚠️ Monitor ya está corriendo');
    return;
  }

  botInstance = telegramBot;
  isRunning = true;

  console.log(`[MONITOR] ═══ INICIANDO ═══`);
  console.log(`[MONITOR] Intervalo: ${formatMs(CONFIG.INTERVAL_MIN_MS)} - ${formatMs(CONFIG.INTERVAL_MAX_MS)} (aleatorio)`);
  console.log(`[MONITOR] Pausa entre números: ${formatMs(CONFIG.PER_NUMBER_MIN_MS)} - ${formatMs(CONFIG.PER_NUMBER_MAX_MS)}`);
  console.log(`[MONITOR] Horario activo: ${CONFIG.ACTIVE_HOURS_START}h - ${CONFIG.ACTIVE_HOURS_END}h`);
  console.log(`[MONITOR] Cooldown por número: ${formatMs(CONFIG.PER_NUMBER_COOLDOWN_MS)}`);

  await refreshMonitorCache();

  // Primer ciclo con delay de 1 minuto para dejar que WhatsApp se estabilice
  console.log('[MONITOR] Esperando 1 min antes del primer ciclo...');
  await sleep(60 * 1000);

  scheduleNextCycle(0);
}

// ══════════════════════════════════════════
// SCHEDULE — Programa el siguiente ciclo
// ══════════════════════════════════════════

function scheduleNextCycle(delayMs = null) {
  if (!isRunning) return;

  const delay = delayMs !== null
    ? delayMs
    : randomDelay(CONFIG.INTERVAL_MIN_MS, CONFIG.INTERVAL_MAX_MS);

  console.log(`[MONITOR] ⏰ Próximo ciclo en ${formatMs(delay)}`);

  monitorTimeout = setTimeout(async () => {
    try {
      await runMonitorCycle();
    } catch (e) {
      console.error(`[MONITOR] Error en ciclo: ${e.message}`);
    } finally {
      scheduleNextCycle(); // Reprogramar
    }
  }, delay);
}

// ══════════════════════════════════════════
// STOP
// ══════════════════════════════════════════

function stopMonitor() {
  if (monitorTimeout) {
    clearTimeout(monitorTimeout);
    monitorTimeout = null;
  }
  isRunning = false;
  dbg('MONITOR', '⏹️ Monitor detenido');
}

// ══════════════════════════════════════════
// REFRESH CACHE
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

    console.log(`[MONITOR] Cache: ${monitorCache.size} usuarios`);
  } catch (e) {
    console.error(`[MONITOR] Error cache: ${e.message}`);
  }
}

// ══════════════════════════════════════════
// CICLO PRINCIPAL
// ══════════════════════════════════════════

async function runMonitorCycle() {
  currentCycleNumber++;
  stats.cyclesRun++;

  console.log(`\n[MONITOR] ═══════ CICLO #${currentCycleNumber} ═══════`);
  console.log(`[MONITOR] Hora: ${new Date().toLocaleString('es-ES')}`);

  // ¿Está en horario activo?
  if (!isActiveHour()) {
    console.log(`[MONITOR] 😴 Fuera de horario activo (${new Date().getHours()}h). Saltando ciclo.`);
    return;
  }

  // ¿WhatsApp está listo?
  if (!whatsapp.isReady()) {
    console.log(`[MONITOR] ⚠️ WhatsApp no listo. Saltando ciclo.`);
    return;
  }

  try {
    // Cargar datos frescos
    const suspendedData = await github.getSuspendedNumbers();
    const suspendedSet = new Set(suspendedData.numbers || []);

    const authData = await github.getAuthorizedUsers();
    const authorizedUsers = Object.keys(authData.users || {});

    await refreshMonitorCache();

    // Contar total de números a verificar
    let totalNumbers = 0;
    for (const userId of authorizedUsers) {
      const numbers = monitorCache.get(userId);
      if (numbers) totalNumbers += numbers.size;
    }

    console.log(`[MONITOR] ${authorizedUsers.length} usuarios, ${totalNumbers} números`);

    if (totalNumbers === 0) {
      console.log(`[MONITOR] No hay números. Fin del ciclo.`);
      return;
    }

    // Verificar cada número
    let checked = 0;
    for (const userId of authorizedUsers) {
      const numbers = monitorCache.get(userId);
      if (!numbers || numbers.size === 0) continue;

      for (const phone of Array.from(numbers)) {
        // Saltar si ya está suspendido
        if (suspendedSet.has(phone)) {
          console.log(`[MONITOR] ⏭️ ${phone} ya suspendido`);
          continue;
        }

        // Saltar si está en cooldown
        if (!canCheckNumber(phone)) {
          const last = lastCheckByNumber.get(phone);
          const elapsed = Date.now() - last;
          console.log(`[MONITOR] ⏭️ ${phone} en cooldown (${formatMs(elapsed)}/${formatMs(CONFIG.PER_NUMBER_COOLDOWN_MS)})`);
          stats.skipped++;
          continue;
        }

        // Verificar
        checked++;
        stats.totalChecks++;
        markNumberChecked(phone);

        console.log(`[MONITOR] 🔍 Verificando ${phone} (${checked}/${totalNumbers})...`);

        try {
          const result = await whatsapp.checkNumberStatus(phone);

          console.log(`[MONITOR] 📊 ${phone} → ${result.status}`);

          // Si está baneado
          if (result.status === 'PERMANENT_BAN' || result.status === 'SPAM_BAN' || result.status === 'TEMPORARY_BAN') {
            console.log(`[MONITOR] 🚫 ${phone} BANEADO → Notificando a ${userId}`);

            // Agregar a suspendidos
            suspendedData.numbers.push(phone);
            suspendedSet.add(phone);
            await github.setSuspendedNumbers(suspendedData);

            // Eliminar de lista del usuario
            numbers.delete(phone);
            monitorCache.set(userId, numbers);
            await github.setUserMonitorList(userId, {
              userId,
              numbers: Array.from(numbers),
            });

            // Notificar
            await notifyUser(userId, phone, result);
            stats.bannedDetected++;

            // Recargar suspendidos (para otros usuarios)
            const fresh = await github.getSuspendedNumbers();
            suspendedSet.clear();
            (fresh.numbers || []).forEach(n => suspendedSet.add(n));
          } else if (result.status === 'ACTIVE') {
            console.log(`[MONITOR] ✅ ${phone} activo`);
          } else if (result.status === 'ERROR') {
            console.log(`[MONITOR] ⚠️ ${phone} error: ${result.message}`);
            stats.errors++;
          }

        } catch (e) {
          console.error(`[MONITOR] ❌ Error en ${phone}: ${e.message}`);
          stats.errors++;
        }

        // Pausa aleatoria entre números (30-60s)
        const pause = randomDelay(CONFIG.PER_NUMBER_MIN_MS, CONFIG.PER_NUMBER_MAX_MS);
        console.log(`[MONITOR] ⏸️ Pausa ${formatMs(pause)} antes del siguiente...`);
        await sleep(pause);
      }
    }

    console.log(`[MONITOR] ✅ Ciclo #${currentCycleNumber} completado (${checked} verificados)`);
    console.log(`[MONITOR] 📊 Stats: ${JSON.stringify(stats)}`);
    console.log(`[MONITOR] ═══════════════════════════\n`);

  } catch (e) {
    console.error(`[MONITOR] ❌ Error en ciclo: ${e.message}`);
    console.error(e.stack);
  }
}

// ══════════════════════════════════════════
// NOTIFICAR
// ══════════════════════════════════════════

async function notifyUser(userId, phone, result) {
  if (!botInstance) {
    console.log('[MONITOR] ⚠️ No hay bot para notificar');
    return;
  }

  const statusEmoji =
    result.status === 'TEMPORARY_BAN' ? '⚠️' :
    result.status === 'SPAM_BAN' ? '🚫' :
    '❌';

  const statusText =
    result.status === 'TEMPORARY_BAN' ? 'Baneo temporal' :
    result.status === 'SPAM_BAN' ? 'Baneo por spam' :
    'Baneo permanente';

  const message = [
    '🚨 <b>ALERTA DE BANEO</b> 🚨',
    '',
    `📱 <b>Número:</b> <code>+${phone}</code>`,
    `${statusEmoji} <b>Estado:</b> ${statusText}`,
    `💬 <b>Mensaje:</b> ${result.message || 'N/A'}`,
    '',
    `⏰ <b>Fecha:</b> ${new Date().toLocaleString('es-ES')}`,
    '',
    '❌ Este número ha sido <b>eliminado</b> de tu lista de monitoreo.',
    '💡 Ya no se volverá a monitorear.',
  ].join('\n');

  try {
    await botInstance.telegram.sendMessage(userId, message, {
      parse_mode: 'HTML',
    });
    console.log(`[MONITOR] 📨 Notificación enviada a ${userId}`);
  } catch (e) {
    console.error(`[MONITOR] ❌ Error enviando a ${userId}: ${e.message}`);
  }
}

// ══════════════════════════════════════════
// ADD / REMOVE
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

  console.log(`[MONITOR] ➕ ${phone} agregado a ${userId}`);
  return { success: true };
}

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

  console.log(`[MONITOR] ➖ ${phone} eliminado de ${userId}`);
  return { success: true };
}

// ══════════════════════════════════════════
// GETTERS
// ══════════════════════════════════════════

async function getUserMonitoredNumbers(userId) {
  const data = await github.getUserMonitorList(userId);
  return data.numbers || [];
}

async function getUserSuspendedNumbers(userId) {
  const allSuspended = await github.getSuspendedNumbers();
  return allSuspended.numbers || [];
}

function getStats() {
  return {
    ...stats,
    running: isRunning,
    cyclesRun: stats.cyclesRun,
    currentCycle: currentCycleNumber,
    monitoredNumbers: monitorCache.size,
    nextRun: monitorTimeout ? 'programado' : 'detenido',
  };
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
  getStats,
  getMonitorCache: () => monitorCache,
  CONFIG,
};
