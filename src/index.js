// ══════════════════════════════════════════
// DIAGNÓSTICO TEMPORAL DE VARIABLES
// ══════════════════════════════════════════
console.log('--- DIAGNÓSTICO DE VARIABLES ---');
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? `DEFINIDA (${process.env.TELEGRAM_BOT_TOKEN.length} chars)` : 'NO DEFINIDA');
console.log('GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? `DEFINIDA (${process.env.GITHUB_TOKEN.length} chars)` : 'NO DEFINIDA');
console.log('GITHUB_OWNER:', process.env.GITHUB_OWNER || 'NO DEFINIDA');
console.log('GITHUB_REPO:', process.env.GITHUB_REPO || 'NO DEFINIDA');
console.log('ADMIN_TELEGRAM_ID:', process.env.ADMIN_TELEGRAM_ID || 'NO DEFINIDA');
console.log('TOTAL ENV VARS:', Object.keys(process.env).length);
console.log('--- FIN DIAGNÓSTICO ---');

const config = require('./config');
const { dbg } = config;
const whatsapp = require('./whatsapp');
const monitor = require('./monitor');
const bot = require('./bot');
const github = require('./github');
const sessionBackup = require('./session-backup');
const qrModule = require('./qr');

// ══════════════════════════════════════════
// MANEJO DE ERRORES GLOBALES
// ══════════════════════════════════════════

process.on('unhandledRejection', (error) => {
  console.error('❌ Unhandled Rejection:', error);
  dbg('GLOBAL', `Unhandled Rejection: ${error.message}`);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  dbg('GLOBAL', `Uncaught Exception: ${error.message}`);
});

// ══════════════════════════════════════════
// FUNCIÓN PRINCIPAL
// ══════════════════════════════════════════

async function main() {
  console.log('\n══════════════════════════════════════════════');
  console.log('  🤖 BanChecker Bot — Iniciando...');
  console.log('══════════════════════════════════════════════\n');

  dbg('MAIN', 'Configuración cargada', {
    owner: config.github.owner,
    repo: config.github.repo,
    adminId: config.telegram.adminId,
  });

  // ══════════════════════════════════════════
  // 1. VERIFICAR GITHUB
  // ══════════════════════════════════════════

  console.log('🐙 Verificando conexión con GitHub...');

  try {
    const files = await github.listLogsFiles();
    console.log(`✅ GitHub conectado (${files.length} archivos en logs/)\n`);
  } catch (e) {
    console.error('❌ Error conectando con GitHub:', e.message);
    console.log('\n💡 Verifica que:');
    console.log('   1. El GITHUB_TOKEN sea válido');
    console.log('   2. El repositorio exista');
    console.log('   3. La carpeta logs/ exista\n');
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // 2. VERIFICAR / RESTAURAR SESIÓN
  // ══════════════════════════════════════════

  console.log('💾 Verificando sesión de WhatsApp...');

  const hasLocal = sessionBackup.hasLocalSession();

  if (hasLocal) {
    console.log('✅ Sesión local encontrada, se usará esa\n');
  } else {
    console.log('⚠️ No hay sesión local, buscando backup en GitHub...');

    try {
      const hasRemote = await sessionBackup.hasRemoteBackup();

      if (hasRemote) {
        console.log('📥 Backup encontrado, restaurando...');
        const result = await sessionBackup.restoreSession();

        if (result.success) {
          console.log(`✅ Sesión restaurada (${result.fileCount} archivos)\n`);
        } else {
          console.log(`⚠️ No se pudo restaurar: ${result.reason}\n`);
        }
      } else {
        console.log('ℹ️ No hay backup remoto. Se pedirá QR.\n');
      }
    } catch (e) {
      console.log(`⚠️ Error buscando backup: ${e.message}\n`);
    }
  }

  // ══════════════════════════════════════════
  // 3. INICIAR BOT DE TELEGRAM (ANTES QUE WHATSAPP)
  //    para que pueda enviar el QR cuando aparezca
  // ══════════════════════════════════════════

  console.log('🤖 Iniciando bot de Telegram...');

  try {
    await bot.launch();
    console.log('✅ Bot de Telegram iniciado\n');
  } catch (e) {
    console.error('❌ Error iniciando bot:', e.message);
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // 4. CONECTAR QR → TELEGRAM
  // ══════════════════════════════════════════

  whatsapp.emitter.on('qr', async (qr) => {
    dbg('MAIN', 'QR emitido, enviando a Telegram...');

    const sent = await qrModule.sendQRToAdmin(bot, qr);

    if (!sent) {
      console.log('\n⚠️ No se pudo enviar el QR por Telegram.');
      console.log('   Revisa los logs de arriba o usa /session en el bot.\n');
    }
  });

  whatsapp.emitter.on('authenticated', () => {
    dbg('MAIN', '✅ Autenticado, el QR ya no es válido');
    qrModule.clearQR();
  });

  whatsapp.emitter.on('ready', async (info) => {
    dbg('MAIN', `✅ WhatsApp listo: +${info?.wid?.user}`);

    // Notificar al admin
    try {
      await bot.telegram.sendMessage(
        config.telegram.adminId,
        `✅ *WhatsApp conectado*\n\n` +
        `📞 Número: \`+${info?.wid?.user}\`\n` +
        `👤 Nombre: ${info?.pushname}\n\n` +
        `⏰ ${new Date().toLocaleString('es-ES')}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      dbg('MAIN', `Error notificando conexión: ${e.message}`);
    }

    // Backup automático de sesión a GitHub (con delay para que Chrome escriba todo)
    setTimeout(async () => {
      dbg('MAIN', 'Iniciando backup automático de sesión...');
      try {
        const result = await sessionBackup.backupSession('Auto-backup on ready [bot]');
        if (result.success) {
          dbg('MAIN', `✅ Auto-backup OK (${result.sizeMB.toFixed(2)} MB)`);
        } else {
          dbg('MAIN', `⚠️ Auto-backup falló: ${result.reason}`);
        }
      } catch (e) {
        dbg('MAIN', `❌ Error auto-backup: ${e.message}`);
      }
    }, 15000); // 15 segundos de delay
  });

  whatsapp.emitter.on('disconnected', (reason) => {
    dbg('MAIN', `❌ WhatsApp desconectado: ${reason}`);

    bot.telegram.sendMessage(
      config.telegram.adminId,
      `⚠️ *WhatsApp desconectado*\n\n` +
      `Motivo: ${reason}\n\n` +
      `Usa /session para ver el estado.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  whatsapp.emitter.on('auth_failure', (msg) => {
    dbg('MAIN', `❌ Fallo de autenticación: ${msg}`);

    bot.telegram.sendMessage(
      config.telegram.adminId,
      `❌ *Fallo de autenticación*\n\n${msg}\n\n` +
      `Usa /session logout y reinicia para generar un QR nuevo.`,
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  });

  // ══════════════════════════════════════════
  // 5. INICIALIZAR WHATSAPP
  // ══════════════════════════════════════════

  console.log('📱 Inicializando WhatsApp...');
  console.log('   (El QR se enviará por Telegram al admin)\n');

  try {
    await whatsapp.initializeWhatsApp();
    console.log('✅ WhatsApp conectado\n');
  } catch (e) {
    console.error('❌ Error inicializando WhatsApp:', e.message);
    console.log('\n💡 Posibles soluciones:');
    console.log('   1. Verifica que Chrome esté instalado');
    console.log('   2. Usa /session logout en Telegram y reinicia');
    console.log('   3. Revisa que el Volume de Railway esté montado\n');

    try {
      await bot.telegram.sendMessage(
        config.telegram.adminId,
        `❌ *Error inicializando WhatsApp*\n\n${e.message}`,
        { parse_mode: 'Markdown' }
      );
    } catch {}

    process.exit(1);
  }

  // ══════════════════════════════════════════
  // 6. INICIAR MONITOR
  // ══════════════════════════════════════════

  console.log('⏰ Iniciando monitor...');

  try {
    await monitor.startMonitor(bot);
    console.log('✅ Monitor iniciado (intervalo: 60s)\n');
  } catch (e) {
    console.error('❌ Error iniciando monitor:', e.message);
  }

  // ══════════════════════════════════════════
  // 7. BACKUP PERIÓDICO (cada 6 horas)
  // ══════════════════════════════════════════

  setInterval(async () => {
    dbg('MAIN', '🔄 Backup periódico de sesión...');
    try {
      await sessionBackup.backupSession('Periodic backup [bot]');
    } catch (e) {
      dbg('MAIN', `Error backup periódico: ${e.message}`);
    }
  }, 6 * 60 * 60 * 1000); // 6 horas

  // ══════════════════════════════════════════
  // 8. MENSAJE FINAL
  // ══════════════════════════════════════════

  console.log('══════════════════════════════════════════════');
  console.log('  ✅ BOT COMPLETAMENTE INICIADO');
  console.log('══════════════════════════════════════════════');
  console.log(`  📱 WhatsApp: Conectado`);
  console.log(`  🤖 Telegram: Activo`);
  console.log(`  ⏰ Monitor: Cada 60 segundos`);
  console.log(`  💾 Backup: Automático cada 6h`);
  console.log(`  🆔 Admin: ${config.telegram.adminId}`);
  console.log('══════════════════════════════════════════════\n');

  dbg('MAIN', 'Bot completamente iniciado');
}

// ══════════════════════════════════════════
// MANEJO DE CIERRE GRACEFUL
// ══════════════════════════════════════════

async function shutdown(signal) {
  console.log(`\n⏹️ Recibida señal ${signal}, cerrando...`);

  monitor.stopMonitor();

  // Backup antes de cerrar
  try {
    console.log('💾 Backup de sesión antes de cerrar...');
    await sessionBackup.backupSession('Shutdown backup [bot]');
  } catch (e) {
    dbg('SHUTDOWN', `Error backup en shutdown: ${e.message}`);
  }

  try {
    await bot.stop(signal);
  } catch (e) {
    dbg('SHUTDOWN', `Error deteniendo bot: ${e.message}`);
  }

  try {
    await whatsapp.destroyClient();
  } catch (e) {
    dbg('SHUTDOWN', `Error destruyendo WhatsApp: ${e.message}`);
  }

  console.log('👋 Hasta luego\n');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ══════════════════════════════════════════
// EJECUTAR
// ══════════════════════════════════════════

main().catch(e => {
  console.error('❌ Error fatal:', e);
  process.exit(1);
});
