// ══════════════════════════════════════════
// COMANDO ADMIN: /session
// ══════════════════════════════════════════

bot.command('session', async (ctx) => {
  // Solo admin
  if (ctx.from.id !== config.telegram.adminId) {
    return ctx.reply('⛔ Acceso denegado. Solo el administrador.');
  }

  const args = ctx.message.text.split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  const sessionBackup = require('./session-backup');
  const qrModule = require('./qr');

  // ── /session (sin args) → estado + QR si hay pendiente
  if (!subcommand) {
    try {
      const hasLocal = sessionBackup.hasLocalSession();
      const waReady = whatsapp.isReady();
      const info = whatsapp.getClient()?.info;
      const hasQR = qrModule.hasQR();

      const lines = [
        '🔐 *ESTADO DE SESIÓN*',
        '',
        `📱 WhatsApp: ${waReady ? '✅ Conectado' : '❌ Desconectado'}`,
      ];

      if (info?.wid?.user) {
        lines.push(`📞 Número: \`+${info.wid.user}\``);
        lines.push(`👤 Nombre: ${info.pushname || 'N/A'}`);
      }

      lines.push(`💾 Sesión local: ${hasLocal ? '✅ Existe' : '❌ No existe'}`);

      try {
        const remoteInfo = await sessionBackup.getRemoteBackupInfo();
        if (remoteInfo) {
          lines.push(`☁️ Backup GitHub: ✅ ${remoteInfo.sizeMB.toFixed(2)} MB`);
        } else {
          lines.push(`☁️ Backup GitHub: ❌ No hay`);
        }
      } catch (e) {
        lines.push(`☁️ Backup GitHub: ⚠️ Error consultando`);
      }

      lines.push('');
      lines.push('📋 *Subcomandos:*');
      lines.push('`/session backup` — Forzar backup a GitHub');
      lines.push('`/session restore` — Restaurar desde GitHub');
      lines.push('`/session logout` — Borrar sesión (requiere nuevo QR)');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('☁️ Backup', 'session_backup'),
          Markup.button.callback('🔽 Restore', 'session_restore'),
        ],
        [
          Markup.button.callback('🚪 Logout', 'session_logout'),
        ],
      ]);

      await ctx.replyWithMarkdown(lines.join('\n'), keyboard);

      // Si hay QR pendiente, enviarlo
      if (hasQR) {
        const qrBuffer = qrModule.getCurrentQRBuffer();
        const qrTime = qrModule.getCurrentQRTime();

        await ctx.replyWithPhoto(
          { source: qrBuffer },
          {
            caption: [
              '📲 *QR ACTUAL PENDIENTE*',
              '',
              `⏰ Generado: ${qrTime?.toLocaleString('es-ES')}`,
              '',
              'Escanea con WhatsApp → Dispositivos vinculados',
            ].join('\n'),
            parse_mode: 'Markdown',
          }
        );
      }
    } catch (e) {
      dbg('BOT', `Error en /session: ${e.message}`);
      await ctx.reply(`❌ Error: ${e.message}`);
    }
    return;
  }

  // ── /session backup
  if (subcommand === 'backup') {
    const msg = await ctx.reply('🔼 Subiendo sesión a GitHub...');

    try {
      const result = await sessionBackup.backupSession('Manual backup via /session [bot]');

      if (result.success) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          undefined,
          [
            '✅ *Backup completado*',
            '',
            `📦 Tamaño: ${result.sizeMB.toFixed(2)} MB`,
            `📁 Archivos: ${result.fileCount}`,
            `☁️ Ubicación: \`logs/session.zip\``,
          ].join('\n'),
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          undefined,
          `⚠️ *Backup falló:* ${result.reason}${result.error ? '\n' + result.error : ''}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        `❌ Error: ${e.message}`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // ── /session restore
  if (subcommand === 'restore') {
    const msg = await ctx.reply('🔽 Restaurando sesión desde GitHub...');

    try {
      const result = await sessionBackup.restoreSession();

      if (result.success) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          undefined,
          [
            '✅ *Sesión restaurada*',
            '',
            `📁 Archivos: ${result.fileCount}`,
            '',
            '💡 *Reinicia el bot* para que use la nueva sesión.',
            '(O espera al siguiente reinicio automático)',
          ].join('\n'),
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          msg.message_id,
          undefined,
          `⚠️ *Restore falló:* ${result.reason}${result.error ? '\n' + result.error : ''}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        `❌ Error: ${e.message}`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // ── /session logout
  if (subcommand === 'logout') {
    const confirmKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⚠️ SÍ, borrar sesión', 'session_logout_confirm'),
        Markup.button.callback('❌ Cancelar', 'session_logout_cancel'),
      ],
    ]);

    return ctx.replyWithMarkdown(
      '⚠️ *¿Estás seguro?*\n\n' +
      'Esto borrará la sesión local Y el backup en GitHub.\n' +
      'Tendrás que escanear un QR nuevo.\n\n' +
      '¿Continuar?',
      confirmKeyboard
    );
  }

  // Subcomando desconocido
  return ctx.replyWithMarkdown(
    '❌ Subcomando desconocido.\n\n' +
    'Usa: `/session`, `/session backup`, `/session restore`, `/session logout`'
  );
});

// ══════════════════════════════════════════
// ACCIONES DE SESIÓN (botones)
// ══════════════════════════════════════════

bot.action('session_backup', async (ctx) => {
  await ctx.answerCbQuery('Iniciando backup...');
  const sessionBackup = require('./session-backup');

  try {
    const result = await sessionBackup.backupSession('Backup via botón [bot]');

    if (result.success) {
      await ctx.replyWithMarkdown(
        `✅ Backup completado: ${result.sizeMB.toFixed(2)} MB (${result.fileCount} archivos)`
      );
    } else {
      await ctx.replyWithMarkdown(`⚠️ Backup falló: ${result.reason}`);
    }
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

bot.action('session_restore', async (ctx) => {
  await ctx.answerCbQuery('Restaurando...');
  const sessionBackup = require('./session-backup');

  try {
    const result = await sessionBackup.restoreSession();

    if (result.success) {
      await ctx.replyWithMarkdown(
        `✅ Sesión restaurada (${result.fileCount} archivos).\n💡 Reinicia el bot para aplicarla.`
      );
    } else {
      await ctx.replyWithMarkdown(`⚠️ Restore falló: ${result.reason}`);
    }
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

bot.action('session_logout', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    '⚠️ Usa `/session logout` desde el chat para confirmar.'
  );
});

bot.action('session_logout_confirm', async (ctx) => {
  await ctx.answerCbQuery('Borrando...');
  const sessionBackup = require('./session-backup');

  try {
    await sessionBackup.deleteSession();
    await ctx.editMessageText('✅ Sesión eliminada. Reinicia el bot para generar un nuevo QR.');
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

bot.action('session_logout_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelado');
  await ctx.editMessageText('❌ Operación cancelada.');
});
