/**
 * PUNTO DE ENTRADA PRINCIPAL — v3 DIAGNÓSTICO TOTAL
 * - Verifica exhaustivamente la sesión antes de iniciar
 * - Muestra exactamente qué archivos hay y si LocalAuth los encuentra
 * - Restaura backup con verificación post-restore
 * - Auto-backup cada 1 hora (no 15s)
 */

// ══════════════════════════════════════════
// DIAGNÓSTICO INICIAL
// ══════════════════════════════════════════
console.log('════════════════════════════════════════════');
console.log('  DIAGNÓSTICO DE ENTORNO');
console.log('════════════════════════════════════════════');
console.log('NODE_VERSION:', process.version);
console.log('CWD:', process.cwd());
console.log('__dirname:', __dirname);
console.log('TELEGRAM_BOT_TOKEN:', process.env.TELEGRAM_BOT_TOKEN ? 'DEFINIDA' : 'NO');
console.log('GITHUB_TOKEN:', process.env.GITHUB_TOKEN ? 'DEFINIDA' : 'NO');
console.log('ADMIN_TELEGRAM_ID:', process.env.ADMIN_TELEGRAM_ID || 'NO');
console.log('CHROME_PATH:', process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || 'NO');
console.log('PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH || 'NO');
console.log('════════════════════════════════════════════\n');

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { dbg } = config;

// ══════════════════════════════════════════
// HELPER: VERIFICAR ESTADO DE LA SESIÓN
// ══════════════════════════════════════════

function inspectSessionDir(label) {
  console.log(`\n═══ INSPECCIÓN DE SESIÓN (${label}) ═══`);

  const sessionPath = config.whatsapp.sessionPath;
  const sessionId = config.whatsapp.sessionId;
  const localAuthDir = path.join(sessionPath, `session-${sessionId}`);

  console.log(`sessionPath: ${sessionPath}`);
  console.log(`sessionId: ${sessionId}`);
  console.log(`localAuthDir esperado: ${localAuthDir}`);

  // ¿Existe el directorio raíz?
  const rootExists = fs.existsSync(sessionPath);
  console.log(`¿Existe ${sessionPath}? ${rootExists}`);

  if (rootExists) {
    try {
      const entries = fs.readdirSync(sessionPath);
      console.log(`Contenido de ${sessionPath}:`, entries);
    } catch (e) {
      console.error(`Error leyendo ${sessionPath}:`, e.message);
    }
  }

  // ¿Existe el directorio de LocalAuth?
  const laExists = fs.existsSync(localAuthDir);
  console.log(`¿Existe ${localAuthDir}? ${laExists}`);

  if (laExists) {
    try {
      const entries = fs.readdirSync(localAuthDir);
      console.log(`Contenido de ${localAuthDir}:`, entries);

      // Contar archivos recursivamente
      let fileCount = 0;
      let totalSize = 0;
      const walk = (dir) => {
        try {
          const list = fs.readdirSync(dir, { withFileTypes: true });
          for (const item of list) {
            const full = path.join(dir, item.name);
            if (item.isDirectory()) {
              walk(full);
            } else if (item.isFile()) {
              fileCount++;
              try {
                totalSize += fs.statSync(full).size;
              } catch (e) {}
            }
          }
        } catch (e) {}
      };
      walk(localAuthDir);

      console.log(`Total archivos en session-${sessionId}: ${fileCount}`);
      console.log(`Tamaño total: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

      // Verificar archivos clave de Chrome
      const defaultDir = path.join(localAuthDir, 'Default');
      console.log(`¿Existe Default/? ${fs.existsSync(defaultDir)}`);

      if (fs.existsSync(defaultDir)) {
        const keyFiles = ['Local Storage', 'IndexedDB', 'Cookies', 'Preferences'];
        for (const f of keyFiles) {
          const p = path.join(defaultDir, f);
          console.log(`  - ${f}: ${fs.existsSync(p) ? '✅' : '❌'}`);
        }
      }
    } catch (e) {
      console.error(`Error inspeccionando:`, e.message);
    }
  }

  console.log(`═══ FIN INSPECCIÓN ═══\n`);
  return laExists && fs.existsSync(path.join(localAuthDir, 'Default'));
}

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
// ESC
// ══════════════════════════════════════════

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  🤖 BanChecker Bot — Iniciando...');
  console.log('══════════════════════════════════════════════\n');

  const whatsapp = require('./whatsapp');
  const monitor = require('./monitor');
  const bot = require('./bot');
  const github = require('./github');
  const sessionBackup = require('./session-backup');

  dbg('MAIN', 'Módulos cargados');

  // ══════════════════════════════════════════
  // 1. GITHUB
  // ══════════════════════════════════════════
  console.log('🐙 Verificando GitHub...');
  try {
    const files = await github.listLogsFiles();
    console.log(`✅ GitHub OK (${files.length} archivos en logs/)`);
    console.log(`Archivos:`, files);
  } catch (e) {
    console.error('❌ GitHub falló:', e.message);
    process.exit(1);
  }

  // ══════════════════════════════════════════
  // 2. INSPECCIÓN DE SESIÓN ANTES DE CUALQUIER COSA
  // ══════════════════════════════════════════
  console.log('\n💾 INSPECCIÓN INICIAL DE SESIÓN');
  const hasLocalBeforeRestore = inspectSessionDir('ANTES DE RESTORE');

  // ══════════════════════════════════════════
  // 3. RESTAURAR SESIÓN SI HACE FALTA
  // ══════════════════════════════════════════
  if (!hasLocalBeforeRestore) {
    console.log('⚠️ No hay sesión local válida. Buscando backup en GitHub...\n');

    try {
      const sessions = await sessionBackup.listSessions();
      console.log(`📦 Sesiones en GitHub: ${sessions.length}`);
      sessions.forEach((s, i) => console.log(`   ${i + 1}. ${s.filename} (${s.pretty})`));

      if (sessions.length > 0) {
        console.log('\n📥 Restaurando backup...');
        const result = await sessionBackup.restoreSession();

        if (result.success) {
          console.log(`✅ Restaurado: ${result.fileCount} archivos desde ${result.filename}`);

          // ⭐ VERIFICACIÓN POST-RESTORE
          const hasLocalAfterRestore = inspectSessionDir('DESPUÉS DE RESTORE');

          if (!hasLocalAfterRestore) {
            console.error('❌ CRÍTICO: El backup se restauró pero la estructura NO es válida.');
            console.error('   LocalAuth no encontrará la sesión.');
            console.error('   → Probablemente el backup se hizo mal (no incluye session-ghost/Default/)');
          } else {
            console.log('✅ Post-restore: estructura válida detectada');
          }
        } else {
          console.log(`⚠️ Restore falló: ${result.reason} — ${result.message}`);
        }
      } else {
        console.log('ℹ️ No hay backups en GitHub. Se pedirá QR al usuario.');
      }
    } catch (e) {
      console.error('❌ Error buscando/restaurando:', e.message);
    }
  } else {
    console.log('✅ Sesión local válida encontrada. Se usará directamente.\n');
  }

  // ══════════════════════════════════════════
  // 4. LISTENERS DE WHATSAPP
  // ══════════════════════════════════════════
  console.log('[MAIN] Registrando listeners de WhatsApp...');

  whatsapp.emitter.on('authenticated', () => {
    console.log('\n[MAIN] ✅ WhatsApp autenticado\n');
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

    // ⭐ Auto-backup tras 5 MINUTOS (no 15s), para que WhatsApp esté estable
    setTimeout(async () => {
      try {
        console.log('[MAIN] Iniciando auto-backup programado (5 min después de connect)...');
        const phone = info?.wid?.user;
        const r = await sessionBackup.backupSession('Auto-backup [bot]', phone);
        if (r.success) {
          console.log(`[MAIN] ✅ Auto-backup OK (${r.sizeMB.toFixed(2)} MB → ${r.filename})`);
        }
      } catch (e) {
        console.error('[MAIN] Error auto-backup:', e.message);
      }
    }, 5 * 60 * 1000);
  });

  whatsapp.emitter.on('disconnected', (reason) => {
    console.log(`\n[MAIN] ⚠️ WhatsApp desconectado: ${reason}\n`);
    bot.telegram.sendMessage(
      config.telegram.adminId,
      `⚠️ <b>WhatsApp desconectado</b>\n\nMotivo: ${esc(reason)}\n\n` +
      `💡 Reconectando automáticamente...`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  whatsapp.emitter.on('auth_failure', (msg) => {
    console.log(`\n[MAIN] ❌ Fallo auth: ${msg}\n`);
    bot.telegram.sendMessage(
      config.telegram.adminId,
      `❌ <b>Fallo de autenticación</b>\n\n${esc(msg)}\n\n` +
      `💡 Usa /session logout y luego /session.`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  });

  console.log('[MAIN] ✅ Listeners registrados\n');

  // ══════════════════════════════════════════
  // 5. INICIAR WHATSAPP EN BACKGROUND
  // ══════════════════════════════════════════
  console.log('📱 Iniciando WhatsApp...');
  console.log('   ⏳ Puede tardar 1-3 minutos\n');

  // Verificar si hay sesión para saber qué mensaje mostrar
  const hasSession = inspectSessionDir('ANTES DE INITIALIZE');

  if (!hasSession) {
    console.log('⚠️ ADVERTENCIA: No hay sesión válida.');
    console.log('   El bot pedirá QR.');
    console.log('   Si ya escaneaste antes, tu sesión NO se guardó correctamente.');
    console.log('   → Revisa que el backup en GitHub contenga session-ghost/Default/\n');
  }

  whatsapp.initializeWhatsApp(false)
    .then(() => console.log('[MAIN] ✅ WhatsApp inicializado\n'))
    .catch((e) => {
      console.error('[MAIN] ❌ Error inicializando WhatsApp:', e.message);
      console.error(e.stack);
    });

  // ══════════════════════════════════════════
  // 6. BOT DE TELEGRAM (BLOQUEANTE)
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
  // 8. BACKUP PERIÓDICO (cada 1 hora)
  // ══════════════════════════════════════════
  setInterval(async () => {
    try {
      const info = whatsapp.getClient()?.info;
      if (info?.wid?.user) {
        console.log('[MAIN] Backup periódico (1h)...');
        const r = await sessionBackup.backupSession('Periodic 1h [bot]', info.wid.user);
        if (r.success) {
          console.log(`[MAIN] ✅ Backup OK: ${r.filename}`);
        }
      }
    } catch (e) {
      console.error('[MAIN] Error backup periódico:', e.message);
    }
  }, 60 * 60 * 1000);

  // ══════════════════════════════════════════
  // 9. FIN
  // ══════════════════════════════════════════
  console.log('══════════════════════════════════════════════');
  console.log('  ✅ BOT OPERATIVO');
  console.log('  📱 WhatsApp: inicializando en background');
  console.log('  🤖 Telegram: OK');
  console.log('  ⏰ Monitor: cada 60s');
  console.log('  💾 Backup: cada 1h + al cerrar');
  console.log('══════════════════════════════════════════════\n');
}

// ══════════════════════════════════════════
// SHUTDOWN
// ══════════════════════════════════════════

async function shutdown(signal) {
  console.log(`\n⏹️ Cerrando (${signal})...`);

  try {
    const monitor = require('./monitor');
    monitor.stopMonitor();
  } catch (e) {}

  try {
    const whatsapp = require('./whatsapp');
    const sessionBackup = require('./session-backup');
    const info = whatsapp.getClient()?.info;
    if (info?.wid?.user) {
      console.log('[SHUTDOWN] Backup antes de cerrar...');
      await sessionBackup.backupSession('Shutdown [bot]', info.wid.user);
    }
  } catch (e) {
    console.error('[SHUTDOWN] Error backup:', e.message);
  }

  try {
    const bot = require('./bot');
    await bot.stop(signal);
  } catch (e) {}

  try {
    const whatsapp = require('./whatsapp');
    await whatsapp.destroyClient();
  } catch (e) {}

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(e => {
  console.error('❌ Error fatal:', e);
  console.error(e.stack);
  process.exit(1);
});
