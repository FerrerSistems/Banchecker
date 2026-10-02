/**
 * PUNTO DE ENTRADA PRINCIPAL
 * Inicia WhatsApp PRIMERO, Telegram después
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
// ENVIAR QR AL ADMIN
// ══════════════════════════════════════════
async function sendQRToAdmin(qr) {
  console.log('\n[MAIN] 📲 sendQRToAdmin() invocado');
  console.log(`[MAIN] QR length: ${qr?.length}`);
  console.log(`[MAIN] Admin ID: ${config.telegram.adminId}`);

  try {
    console.log('[MAIN] Generando imagen PNG...');
    const buffer = await qrModule.generateQRImage(qr);
    console.log(`[MAIN] Imagen generada: ${(buffer.length / 1024).toFixed(1)} KB`);

    const caption =
      '📲 <b>NUEVO CÓDIGO QR</b>\n\n' +
      'Escanea con WhatsApp:\n' +
      '1. Abre WhatsApp en tu celular\n' +
      '2. Ajustes → Dispositivos vinculados\n' +
      '3. Vincular un dispositivo\n\n' +
      `⏰ ${new Date().toLocaleString('es-ES')}`;

    console.log('[MAIN] Enviando foto a Telegram...');
    await bot.telegram.sendPhoto(
      config.telegram.adminId,
      { source: buffer },
      { caption, parse_mode: 'HTML' }
    );
    console.log('[MAIN] ✅ QR enviado al admin por Telegram\n');
    return true;
  } catch (e) {
    console.error('[MAIN] ❌ Error enviando QR:', e.message);
    console.error('[MAIN] Stack:', e.stack);

    // Fallback: enviar como texto
    try {
      console.log('[MAIN] Intentando enviar QR como texto...');
      await bot.telegram.sendMessage(
        config.telegram.adminId,
        `⚠️ No se pudo enviar el QR como imagen.\n\nError: ${esc(e.message)}\n\nIntenta /session de nuevo.`
      );
    } catch (e2) {
      console.error('[MAIN] ❌ Fallback también falló:', e2.message);
    }
    return false;
  }
}

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
        console.log('ℹ️ Sin backup. Se pedirá QR.\n');
      }
    } catch (e) {
      console.log(`⚠️ ${e.message}\n`);
    }
  }

  // ══════════════════════════════════════════
  // 3. LISTENERS DE WHATSAPP (ANTES DE TODO)
  // ══════════════════════════════════════════
  console.log('[MAIN] Registrando listeners de WhatsApp...');

  whatsapp.emitter.on('qr', async (qr) => {
    console.log('\n[MAIN] ═══════════════════════════════');
    console.log('[MAIN] 📲 Evento QR recibido del emitter');
    console.log('[MAIN] ═══════════════════════════════');
    await sendQRToAdmin(qr);
  });

  whatsapp.emitter.on('authenticated', () => {
    console.log('\n[MAIN] ✅ WhatsApp autenticado\n');
    qrModule.clearQR();
  });

  whatsapp.emitter.on('ready', async (info) => {
    console.log(`\n[MAIN] ✅ WhatsApp LISTO: +${info?.wid?.user}\n`);

    try {
      await bot.telegram.sendMessage(
        config.telegram.adminId,
        `✅ <b>WhatsApp conectado</b>\n\n📞 +${info?.wid?.user}\n👤 ${esc(info?.pushname || 'N/A')}`,
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      console.error('[MAIN] Error notificando:', e.message);
    }

    setTimeout(async () => {
      try {
        const r = await sessionBackup.backupSession('Auto-backup [bot]', info?.wid?.user);
        if (r.success) console.log(`[MAIN] ✅ Auto-backup OK (${r.sizeMB.toFixed(2)} MB)\n`);
      } catch (e) {
        console.error('[MAIN] Error auto-backup:', e.message);
      }
    }, 15000);
  });

  whatsapp.emitter.on('disconnected', (reason) => {
    console.log(`\n[MAIN] ❌ WhatsApp desconectado: ${reason}\n`);
    bot.telegram.sendMessage(
      config.telegram.adminId,
      `⚠️ <b>WhatsApp desconectado</b>\n\nMotivo: ${esc(reason)}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  whatsapp.emitter.on('auth_failure', (msg) => {
    console.log(`\n[MAIN] ❌ Fallo auth: ${msg}\n`);
    bot.telegram.sendMessage(
      config.telegram.adminId,
      `❌ <b>Fallo de autenticación</b>\n\n${esc(msg)}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  console.log('[MAIN] ✅ Listeners registrados\n');

  // ══════════════════════════════════════════
  // 4. INICIAR WHATSAPP
  // ══════════════════════════════════════════
  console.log('📱 Iniciando WhatsApp (Chrome)...');
  console.log('   ⏳ Puede tardar 1-3 minutos\n');

  whatsapp.initializeWhatsApp()
    .then(() => console.log('[MAIN] ✅ WhatsApp inicializado\n'))
    .catch((e) => {
      console.error('[MAIN] ❌ Error inicializando WhatsApp:', e.message);
      console.error(e.stack);
    });

  // ══════════════════════════════════════════
  // 5. TIMEOUT: Si en 3 min no hay QR ni conexión → forzar restart
  // ══════════════════════════════════════════
  setTimeout(async () => {
    try {
      const diag = whatsapp.getDiagnostics();

      if (!diag.ready && !diag.hasQR) {
        console.log('\n[MAIN] ⚠️ 3 min sin QR ni conexión. Forzando restart...');
        console.log('[MAIN] Diag:', JSON.stringify(diag, null, 2));

        try {
          await bot.telegram.sendMessage(
            config.telegram.adminId,
            `⚠️ <b>WhatsApp no responde</b>\n\n` +
            `Evento: <code>${esc(diag.lastEvent)}</code>\n` +
            `Error: ${esc(diag.initError || 'ninguno')}\n\n` +
            `🔄 Forzando reinicio...`,
            { parse_mode: 'HTML' }
          );
        } catch {}

        await whatsapp.restartForQR();
      }
    } catch (e) {
      console.error('[MAIN] Error en timeout restart:', e.message);
    }
  }, 3 * 60 * 1000);

  // ══════════════════════════════════════════
  // 6. TELEGRAM
  // ══════════════════════════════════════════
  console.log('🤖 Iniciando bot de Telegram...');

  try {
    await bot.launch();
    console.log('✅ Bot de Telegram iniciado\n');
  } catch (e) {
    console.error('❌ Error Telegram:', e.message);
  }

  // ══════════════════════════════════════════
  // 7. MONITOR
  // ══════════════════════════════════════════
  console.log('⏰ Iniciando monitor...');
  try {
    await monitor.startMonitor(bot);
    console.log('✅ Monitor iniciado (60s)\n');
  } catch (e) {
    console.error('❌ Monitor:', e.message);
  }

  // ══════════════════════════════════════════
  // 8. BACKUP PERIÓDICO (cada 6h)
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
  // 9. FIN
  // ══════════════════════════════════════════
  console.log('══════════════════════════════════════════════');
  console.log('  ✅ BOT OPERATIVO');
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
