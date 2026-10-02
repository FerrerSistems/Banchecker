/**
 * PUNTO DE ENTRADA PRINCIPAL
 * - NO envía QR automáticamente (evita spam)
 * - El QR se envía solo desde /session
 * - WhatsApp se inicializa en background
 */

// ══════════════════════════════════════════
// DIAGNÓSTICO
// ══════════════════════════════════════════
console.log('--- DIAGNÓSTICO ---');
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? 'DEFINIDA' : 'NO');
console.log('GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? 'DEFINIDA' : 'NO');
console.log('ADMIN_TELEGRAM_ID:', process.env.ADMIN_TELEGRAM_ID || 'NO');
console.log('CHROME_PATH:', process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || 'NO');
console.log('--- FIN ---\n');

const config = require('./config');
const { dbg } = config;
const whatsapp = require('./whatsapp');
const monitor = require('./monitor');
const bot = require('./bot');
const github = require('./github');
const sessionBackup = require('./session-backup');
const qrModule = require('./qr');

// ══════════════════════════════════════════
// ERRORES GLOBALES
// ══════════════════════════════════════════
process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error?.message || error);
});
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error?.message || error);
});

// ══════════════════════════════════════════
// HELPER: escapar HTML para Telegram
// ══════════════════════════════════════════
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// ══════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ══════════════════════════════════════════
async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  🤖 BanChecker Bot — Iniciando...');
  console.log('══════════════════════════════════════════════\n');

  // ══════════════════════════════════════════
  // 1. GITHUB
  // ══════════════════════════════════════════
  console.log('🐙 Verificando GitHub...');
  try {
    const files = await github.listLogsFiles();
    console.log(`✅ GitHub conectado (${files.length} archivos)\n`);
  } catch (e) {
    console.error('❌ GitHub:', e.message);
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // 2. SESIÓN
  // ══════════════════════════════════════════
  console.log('💾 Verificando sesión...');
  if (sessionBackup.hasLocalSession()) {
    console.log('✅ Sesión local encontrada\n');
  } else {
    console.log('⚠️ Sin sesión local, buscando backup...');
    try {
      if (await sessionBackup.hasRemoteBackup()) {
        console.log('📥 Restaurando backup...');
        const r = await sessionBackup.restoreSession();
        console.log(r.success ? `✅ Restaurada (${r.fileCount} archivos)\n` : `⚠️ ${r.reason}\n`);
      } else {
        console.log('ℹ️ Sin backup. Usa /session para generar QR.\n');
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}\n`);
    }
  }

  // ══════════════════════════════════════════
  // 3. LISTENERS DE WHATSAPP (SIN QR AUTOMÁTICO)
  // ══════════════════════════════════════════
  console.log('[MAIN] Registrando listeners de WhatsApp...');

  // ⚠️ NO hay listener de 'qr' → el QR NO se envía automáticamente
  // El QR se envía solo cuando el usuario escribe /session o
  // cuando el usuario hace click en "Generar QR"

  whatsapp.emitter.on('authenticated', () => {
    console.log('\n[MAIN] ✅ WhatsApp autenticado\n');
    try { qrModule.clearQR(); } catch (e) {}
    try { whatsapp.clearQR(); } catch (e) {}
  });

  whatsapp.emitter.on('ready', async (info) => {
    console.log(`\n[MAIN] ✅ WhatsApp LISTO: +${info?.wid?.user}\n`);

    try {
      await bot.telegram.sendMessage(
        config.telegram.adminId,
        `✅ <b>WhatsApp conectado</b>\n\n` +
        `📞 +${esc(info?.wid?.user)}\n` +
        `👤 ${esc(info?.pushname || 'N/A')}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('[MAIN] Error notificando:', e.message);
    }

    // Auto-backup tras 15s
    setTimeout(async () => {
      try {
        const phone = info?.wid?.user;
        const r = await sessionBackup.backupSession('Auto-backup [bot]', phone);
        if (r.success) {
          console.log(`[MAIN] ✅ Auto-backup OK (${r.sizeMB.toFixed(2)} MB → ${r.filename})\n`);
        }
      } catch (e) {
        console.error('[MAIN] Error auto-backup:', e.message);
      }
    }, 15000);
  });

  whatsapp.emitter.on('disconnected', (reason) => {
    console.log(`\n[MAIN] ❌ WhatsApp desconectado: ${reason}\n`);
    bot.telegram.sendMessage(
      config.telegram.adminId,
      `⚠️ <b>WhatsApp desconectado</b>\n\nMotivo: ${esc(reason)}\n\n` +
      `💡 Usa /session para reconectar.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  whatsapp.emitter.on('auth_failure', (msg) => {
    console.log(`\n[MAIN] ❌ Fallo auth: ${msg}\n`);
    bot.telegram.sendMessage(
      config.telegram.adminId,
      `❌ <b>Fallo de autenticación</b>\n\n${esc(msg)}\n\n` +
      `💡 Usa /session logout y luego /session para generar un QR nuevo.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  console.log('[MAIN] ✅ Listeners registrados\n');

  // ══════════════════════════════════════════
  // 4. INICIAR WHATSAPP (BACKGROUND, SIN BLOQUEAR)
  // ══════════════════════════════════════════
  console.log('📱 Iniciando WhatsApp (Chrome)...');
  console.log('   ⏳ Puede tardar 1-3 minutos\n');

  whatsapp.initializeWhatsApp()
    .then(() => console.log('[MAIN] ✅ WhatsApp inicializado\n'))
    .catch((e) => {
      console.error('[MAIN] ❌ Error inicializando WhatsApp:', e.message);
      // NO crashear el bot si WhatsApp falla — el usuario puede usar /session
    });

  // ══════════════════════════════════════════
  // 5. TELEGRAM (BLOQUEANTE)
  // ══════════════════════════════════════════
  console.log('🤖 Iniciando bot de Telegram...');

  try {
    await bot.launch();
    console.log('✅ Bot de Telegram iniciado\n');
  } catch (e) {
    console.error('❌ Error Telegram:', e.message);
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // 6. MONITOR
  // ══════════════════════════════════════════
  console.log('⏰ Iniciando monitor...');
  try {
    await monitor.startMonitor(bot);
    console.log('✅ Monitor iniciado (60s)\n');
  } catch (e) {
    console.error('❌ Monitor:', e.message);
  }

  // ══════════════════════════════════════════
  // 7. BACKUP PERIÓDICO (cada 6h)
  // ══════════════════════════════════════════
  setInterval(async () => {
    try {
      const info = whatsapp.getClient()?.info;
      await sessionBackup.backupSession('Periodic backup [bot]', info?.wid?.user);
    } catch (e) {
      dbg('MAIN', `Error backup: ${e.message}`);
    }
  }, 6 * 60 * 60 * 1000);

  // ══════════════════════════════════════════
  // 8. FIN
  // ══════════════════════════════════════════
  console.log('══════════════════════════════════════════════');
  console.log('  ✅ BOT OPERATIVO');
  console.log('  📱 WhatsApp: Inicializando en background');
  console.log('  🤖 Telegram: Activo');
  console.log('  ⏰ Monitor: Cada 60s');
  console.log('  💾 Backup: Cada 6h + al cerrar');
  console.log('  📲 QR: Solo con /session (sin spam)');
  console.log('══════════════════════════════════════════════\n');
}

// ══════════════════════════════════════════
// SHUTDOWN
// ══════════════════════════════════════════
async function shutdown(signal) {
  console.log(`\n⏹️ Cerrando (${signal})...`);
  monitor.stopMonitor();
  try {
    const info = whatsapp.getClient()?.info;
    await sessionBackup.backupSession('Shutdown [bot]', info?.wid?.user);
  } catch {}
  try { await bot.stop(signal); } catch {}
  try { await whatsapp.destroyClient(); } catch {}
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(e => {
  console.error('❌ Error fatal:', e);
  process.exit(1);
});
