/**
 * BOT DE TELEGRAM
 * Maneja todos los comandos, autenticación y notificaciones
 * Acepta formato DDI + NÚMERO (separados o juntos)
 */

const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const { dbg } = config;
const github = require('./github');
const monitor = require('./monitor');
const whatsapp = require('./whatsapp');

// ══════════════════════════════════════════
// INICIALIZAR BOT
// ══════════════════════════════════════════

const bot = new Telegraf(config.telegram.token);

// ══════════════════════════════════════════
// HELPER: PARSEAR NÚMERO DE TELÉFONO
// Acepta: "51 999999999" o "51999999999"
// Devuelve: { ddi, number, phone } o null si inválido
// ══════════════════════════════════════════

function parsePhone(args) {
  if (!args || args.length === 0) return null;

  let ddi = '';
  let number = '';

  if (args.length >= 2) {
    // Formato: /cmd 51 999999999
    ddi = args[0].replace(/\D/g, '');
    number = args[1].replace(/\D/g, '');
  } else {
    // Formato: /cmd 51999999999
    // Intentar separar DDI (1-3 dígitos) del número
    const raw = args[0].replace(/\D/g, '');

    if (raw.length < 8) return null;

    // Heurística: si el total es >= 11, DDI de 2 dígitos.
    // Si es >= 12, DDI de 3 dígitos (ej: 123 para USA/Canadá no aplica aquí).
    // Ajusta según tu país. Por defecto asumimos 2 dígitos de DDI.
    if (raw.length >= 12) {
      ddi = raw.substring(0, 3);
      number = raw.substring(3);
    } else {
      ddi = raw.substring(0, 2);
      number = raw.substring(2);
    }
  }

  if (!ddi || !number) return null;
  if (number.length < 6) return null;

  return {
    ddi,
    number,
    phone: `${ddi}${number}`, // ← formato para WhatsApp Web
    pretty: `+${ddi} ${number}`,
  };
}

// ══════════════════════════════════════════
// MIDDLEWARE DE AUTENTICACIÓN
// ══════════════════════════════════════════

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();

  if (!userId) {
    return ctx.reply('❌ No se pudo identificar tu usuario.');
  }

  if (ctx.from.id === config.telegram.adminId) {
    return next();
  }

  const auth = await github.isUserAuthorized(userId);

  if (!auth.authorized) {
    const msg = [
      '🔒 *ACCESO DENEGADO*',
      '',
      `❌ ${auth.reason}`,
      '',
      '💡 Solicita acceso al administrador.',
      `📌 Tu ID de Telegram: \`${userId}\``,
    ].join('\n');

    return ctx.reply(msg, { parse_mode: 'Markdown' });
  }

  return next();
});

// ══════════════════════════════════════════
// COMANDO: /start
// ══════════════════════════════════════════

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const isAdmin = userId === config.telegram.adminId;

  const buttons = [
    [
      Markup.button.callback('📊 Estado', 'help_status'),
      Markup.button.callback('➕ Monitorear', 'help_monitor'),
    ],
    [
      Markup.button.callback('📋 Mi lista', 'help_list'),
      Markup.button.callback('ℹ️ Ayuda', 'help_general'),
    ],
  ];

  if (isAdmin) {
    buttons.push([Markup.button.callback('🔐 Sesión', 'help_session')]);
  }

  const keyboard = Markup.inlineKeyboard(buttons);

  const msg = [
    '👋 *¡Bienvenido a BanChecker Bot!*',
    '',
    '🔍 Verifico si números de WhatsApp están activos o baneados.',
    '',
    '📌 *Comandos:*',
    '`/status <DDI> <NÚMERO>` — Verifica un número',
    '`/monitoradd <DDI> <NÚMERO>` — Monitorea un número',
    '`/list` — Tus números monitoreados',
    '`/listban` — Números baneados',
    '`/help` — Ayuda completa',
    ...(isAdmin ? ['`/session` — Gestión de sesión WhatsApp'] : []),
    '',
    '💡 *Ejemplo:* `/status 51 999999999`',
    '',
    `🆔 *Tu ID:* \`${userId}\``,
  ].join('\n');

  await ctx.replyWithMarkdown(msg, keyboard);
});

// ══════════════════════════════════════════
// COMANDO: /help
// ══════════════════════════════════════════

bot.help(async (ctx) => {
  const msg = [
    '📖 *AYUDA COMPLETA — BanChecker Bot*',
    '',
    '🔹 *FORMATO DE NÚMEROS*',
    'Siempre usa: `<DDI> <NÚMERO>` (con espacio)',
    'O todo junto: `<DDI><NÚMERO>`',
    '',
    '✅ Correcto: `/status 51 999999999`',
    '✅ Correcto: `/status 51999999999`',
    '❌ Incorrecto: `/status +51 999-999-999`',
    '❌ Incorrecto: `/status 999999999` (falta DDI)',
    '',
    '🌎 *DDI comunes:*',
    '🇵🇪 Perú: `51`  |  🇲🇽 México: `52`  |  🇦🇷 Argentina: `54`',
    '🇨🇴 Colombia: `57`  |  🇨🇱 Chile: `56`  |  🇪🇸 España: `34`',
    '',
    '🔹 *VERIFICACIÓN*',
    '`/status 51 999999999` — Verifica el estado.',
    '• ✅ Activo',
    '• ⚠️ Baneo temporal (solicitar revisión)',
    '• 🚫 Baneo por spam',
    '• ❌ Baneo permanente (registrar nuevo)',
    '',
    '🔹 *MONITOREO*',
    '`/monitoradd 51 999999999` — Agrega a tu lista.',
    'El bot verificará cada 60s si es baneado.',
    '`/list` — Ver tus números monitoreados.',
    '`/listban` — Ver números baneados.',
    '',
    '🔹 *ADMIN*',
    '`/add <id> <duración>` — Autoriza usuario (ej: 7d, 2h, 30m)',
    '`/remove <id>` — Elimina usuario',
    '`/session` — Gestión de sesión de WhatsApp',
  ].join('\n');

  await ctx.replyWithMarkdown(msg);
});

// ══════════════════════════════════════════
// COMANDO: /status
// ══════════════════════════════════════════

bot.command('status', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);

  if (args.length === 0) {
    return ctx.replyWithMarkdown(
      '❌ *Uso incorrecto*\n\n' +
      '`/status <DDI> <NÚMERO>`\n\n' +
      'Ejemplos:\n' +
      '`/status 51 999999999`\n' +
      '`/status 51999999999`\n\n' +
      '💡 El DDI es el código del país (ej: 51 para Perú).'
    );
  }

  const parsed = parsePhone(args);

  if (!parsed) {
    return ctx.replyWithMarkdown(
      '❌ *Número inválido*\n\n' +
      'Asegúrate de incluir el DDI (código de país).\n\n' +
      'Ejemplo: `/status 51 999999999`'
    );
  }

  const { phone, pretty } = parsed;

  const processingMsg = await ctx.reply(
    `🔄 Verificando ${pretty}... Esto puede tomar unos segundos.`
  );

  try {
    const result = await whatsapp.checkNumberStatus(phone);

    let emoji = '❓';
    let statusText = 'Desconocido';

    switch (result.status) {
      case 'ACTIVE':         emoji = '✅'; statusText = 'Activo'; break;
      case 'TEMPORARY_BAN':  emoji = '⚠️'; statusText = 'Baneo temporal'; break;
      case 'SPAM_BAN':       emoji = '🚫'; statusText = 'Baneo por spam'; break;
      case 'PERMANENT_BAN':  emoji = '❌'; statusText = 'Baneo permanente'; break;
      case 'VERIFY':         emoji = '🔄'; statusText = 'Verificar'; break;
    }

    const msg = [
      `${emoji} *RESULTADO*`,
      '',
      `📱 *Número:* \`${pretty}\``,
      `📊 *Estado:* ${statusText}`,
      `💬 *Mensaje:* ${result.message}`,
      '',
      `⏰ ${new Date().toLocaleString('es-ES')}`,
    ].join('\n');

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      msg,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    dbg('BOT', `Error en /status: ${e.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `❌ *Error:* ${e.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ══════════════════════════════════════════
// COMANDO: /monitoradd
// ══════════════════════════════════════════

bot.command('monitoradd', async (ctx) => {
  const args = ctx.message.text.split(/\s+/).slice(1);

  if (args.length === 0) {
    return ctx.replyWithMarkdown(
      '❌ *Uso incorrecto*\n\n' +
      '`/monitoradd <DDI> <NÚMERO>`\n\n' +
      'Ejemplos:\n' +
      '`/monitoradd 51 999999999`\n' +
      '`/monitoradd 51999999999`\n\n' +
      '💡 Verificación cada 60 segundos.'
    );
  }

  const parsed = parsePhone(args);

  if (!parsed) {
    return ctx.replyWithMarkdown(
      '❌ *Número inválido*\n\n' +
      'Incluye el DDI.\n\n' +
      'Ejemplo: `/monitoradd 51 999999999`'
    );
  }

  const { phone, pretty } = parsed;
  const userId = ctx.from.id.toString();

  const processingMsg = await ctx.reply(`🔄 Agregando ${pretty} a monitoreo...`);

  try {
    const check = await whatsapp.checkNumberStatus(phone);

    if (check.status !== 'ACTIVE' && check.status !== 'VERIFY') {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `⚠️ *El número no está activo.*\n\n` +
        `📊 Estado: ${check.message}\n\n` +
        `💡 No se puede monitorear un número baneado.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const result = await monitor.addNumberToMonitor(userId, phone);

    if (!result.success) {
      let reason = '';
      switch (result.reason) {
        case 'already_exists':
          reason = 'El número ya está en tu lista.';
          break;
        case 'already_suspended':
          reason = 'El número ya está marcado como suspendido.';
          break;
        default:
          reason = 'Error desconocido.';
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `⚠️ *No se pudo agregar*\n\n${reason}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `✅ *Agregado a monitoreo*\n\n` +
      `📱 \`${pretty}\`\n` +
      `⏰ Verificación cada 60s\n\n` +
      `💡 Recibirás notificación si es baneado.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    dbg('BOT', `Error en /monitoradd: ${e.message}`);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `❌ *Error:* ${e.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ══════════════════════════════════════════
// COMANDO: /list
// ══════════════════════════════════════════

bot.command('list', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const numbers = await monitor.getUserMonitoredNumbers(userId);

    if (numbers.length === 0) {
      return ctx.replyWithMarkdown(
        '📋 *Tu lista está vacía.*\n\n' +
        'Usa `/monitoradd 51 999999999` para agregar.'
      );
    }

    const list = numbers.map((n, i) => {
      // Formatear como +DDI NUMBER
      const ddi = n.length >= 12 ? n.substring(0, 3) : n.substring(0, 2);
      const number = n.substring(ddi.length);
      return `${i + 1}. \`+${ddi} ${number}\``;
    }).join('\n');

    await ctx.replyWithMarkdown(
      `📋 *NÚMEROS MONITOREADOS*\n\n${list}\n\n` +
      `📊 Total: ${numbers.length}`
    );
  } catch (e) {
    dbg('BOT', `Error en /list: ${e.message}`);
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// COMANDO: /listban
// ══════════════════════════════════════════

bot.command('listban', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const numbers = await monitor.getUserSuspendedNumbers(userId);

    if (numbers.length === 0) {
      return ctx.replyWithMarkdown(
        '✅ *No hay números baneados.*\n\n' +
        'Todos tus números están activos.'
      );
    }

    const list = numbers.map((n, i) => {
      const ddi = n.length >= 12 ? n.substring(0, 3) : n.substring(0, 2);
      const number = n.substring(ddi.length);
      return `${i + 1}. \`+${ddi} ${number}\``;
    }).join('\n');

    await ctx.replyWithMarkdown(
      `🚫 *NÚMEROS BANEADOS*\n\n${list}\n\n` +
      `📊 Total: ${numbers.length}`
    );
  } catch (e) {
    dbg('BOT', `Error en /listban: ${e.message}`);
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// COMANDO ADMIN: /add
// ══════════════════════════════════════════

bot.command('add', async (ctx) => {
  if (ctx.from.id !== config.telegram.adminId) {
    return ctx.replyWithMarkdown('⛔ *Solo admin.*');
  }

  const args = ctx.message.text.split(/\s+/).slice(1);

  if (args.length < 2) {
    return ctx.replyWithMarkdown(
      '❌ *Uso:* `/add <id_usuario> <duración>`\n\n' +
      'Ejemplos:\n' +
      '`/add 123456789 7d` — 7 días\n' +
      '`/add 123456789 2h` — 2 horas\n' +
      '`/add 123456789 30m` — 30 minutos'
    );
  }

  const targetId = args[0].replace(/\D/g, '');
  const durationStr = args[1].toLowerCase();

  let durationMs = 0;
  const match = durationStr.match(/^(\d+)([mhd])$/);

  if (!match) {
    return ctx.replyWithMarkdown(
      '❌ Formato inválido. Usa: `30m`, `2h`, `7d`'
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm': durationMs = value * 60 * 1000; break;
    case 'h': durationMs = value * 60 * 60 * 1000; break;
    case 'd': durationMs = value * 24 * 60 * 60 * 1000; break;
  }

  try {
    const user = await github.addAuthorizedUser(targetId, durationMs);
    const expiry = new Date(user.expiresAt).toLocaleString('es-ES');

    await ctx.replyWithMarkdown(
      `✅ *Usuario autorizado*\n\n` +
      `🆔 \`${targetId}\`\n` +
      `⏰ Expira: ${expiry}\n` +
      `📅 Duración: ${durationStr}`
    );

    dbg('BOT', `Usuario ${targetId} autorizado por ${durationStr}`);
  } catch (e) {
    dbg('BOT', `Error en /add: ${e.message}`);
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// COMANDO ADMIN: /remove
// ══════════════════════════════════════════

bot.command('remove', async (ctx) => {
  if (ctx.from.id !== config.telegram.adminId) {
    return ctx.reply('⛔ Solo admin.');
  }

  const args = ctx.message.text.split(/\s+/).slice(1);

  if (args.length < 1) {
    return ctx.replyWithMarkdown('❌ Uso: `/remove <id_usuario>`');
  }

  const targetId = args[0].replace(/\D/g, '');

  try {
    await github.removeAuthorizedUser(targetId);
    await ctx.replyWithMarkdown(`✅ Usuario \`${targetId}\` eliminado.`);
  } catch (e) {
    await ctx.reply(`❌ Error: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// COMANDO ADMIN: /session
// ══════════════════════════════════════════

bot.command('session', async (ctx) => {
  if (ctx.from.id !== config.telegram.adminId) {
    return ctx.reply('⛔ Solo admin.');
  }

  const args = ctx.message.text.split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  const sessionBackup = require('./session-backup');
  const qrModule = require('./qr');

  // ── /session (estado)
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

      lines.push(`💾 Sesión local: ${hasLocal ? '✅' : '❌'}`);

      try {
        const remoteInfo = await sessionBackup.getRemoteBackupInfo();
        lines.push(`☁️ Backup GitHub: ${remoteInfo ? `✅ ${remoteInfo.sizeMB.toFixed(2)} MB` : '❌'}`);
      } catch {
        lines.push(`☁️ Backup GitHub: ⚠️ Error`);
      }

      lines.push('');
      lines.push('📋 *Subcomandos:*');
      lines.push('`/session backup` — Subir a GitHub');
      lines.push('`/session restore` — Restaurar desde GitHub');
      lines.push('`/session logout` — Borrar sesión');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('☁️ Backup', 'session_backup'),
          Markup.button.callback('🔽 Restore', 'session_restore'),
        ],
        [Markup.button.callback('🚪 Logout', 'session_logout')],
      ]);

      await ctx.replyWithMarkdown(lines.join('\n'), keyboard);

      if (hasQR) {
        await ctx.replyWithPhoto(
          { source: qrModule.getCurrentQRBuffer() },
          {
            caption: `📲 *QR PENDIENTE*\n\n⏰ ${qrModule.getCurrentQRTime()?.toLocaleString('es-ES')}\n\nEscanea con WhatsApp → Dispositivos vinculados`,
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

  if (subcommand === 'backup') {
    const msg = await ctx.reply('🔼 Subiendo sesión a GitHub...');
    try {
      const result = await sessionBackup.backupSession('Manual backup [bot]');
      if (result.success) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          `✅ *Backup completado*\n\n📦 ${result.sizeMB.toFixed(2)} MB\n📁 ${result.fileCount} archivos\n☁️ \`logs/session.zip\``,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          `⚠️ *Falló:* ${result.reason}${result.error ? '\n' + result.error : ''}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `❌ ${e.message}`, { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  if (subcommand === 'restore') {
    const msg = await ctx.reply('🔽 Restaurando desde GitHub...');
    try {
      const result = await sessionBackup.restoreSession();
      if (result.success) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          `✅ *Sesión restaurada*\n\n📁 ${result.fileCount} archivos\n\n💡 Reinicia el bot.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          `⚠️ *Falló:* ${result.reason}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `❌ ${e.message}`, { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  if (subcommand === 'logout') {
    const confirmKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⚠️ SÍ, borrar', 'session_logout_confirm'),
        Markup.button.callback('❌ Cancelar', 'session_logout_cancel'),
      ],
    ]);

    return ctx.replyWithMarkdown(
      '⚠️ *¿Seguro?*\n\nBorrará sesión local + GitHub.\nNecesitarás nuevo QR.\n\n¿Continuar?',
      confirmKeyboard
    );
  }

  return ctx.replyWithMarkdown(
    '❌ Subcomando desconocido.\n\nUsa: `/session`, `/session backup`, `/session restore`, `/session logout`'
  );
});

// ══════════════════════════════════════════
// ACCIONES DE BOTONES
// ══════════════════════════════════════════

bot.action('help_status', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    '🔍 *Verificar número*\n\n' +
    '`/status 51 999999999`\n\n' +
    '💡 DDI + número, con espacio o junto.'
  );
});

bot.action('help_monitor', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    '➕ *Monitorear*\n\n' +
    '`/monitoradd 51 999999999`\n\n' +
    '💡 Verificación cada 60s.'
  );
});

bot.action('help_list', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    '📋 *Listas*\n\n`/list` — Monitoreados\n`/listban` — Baneados'
  );
});

bot.action('help_general', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown('ℹ️ Usa `/help` para la ayuda completa.');
});

bot.action('help_session', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    '🔐 *Sesión WhatsApp*\n\n' +
    '`/session` — Estado y QR\n' +
    '`/session backup` — Subir a GitHub\n' +
    '`/session restore` — Restaurar\n' +
    '`/session logout` — Borrar'
  );
});

bot.action('session_backup', async (ctx) => {
  await ctx.answerCbQuery('Iniciando backup...');
  const sessionBackup = require('./session-backup');
  try {
    const result = await sessionBackup.backupSession('Backup via botón [bot]');
    if (result.success) {
      await ctx.replyWithMarkdown(`✅ Backup: ${result.sizeMB.toFixed(2)} MB (${result.fileCount} archivos)`);
    } else {
      await ctx.replyWithMarkdown(`⚠️ Falló: ${result.reason}`);
    }
  } catch (e) {
    await ctx.reply(`❌ ${e.message}`);
  }
});

bot.action('session_restore', async (ctx) => {
  await ctx.answerCbQuery('Restaurando...');
  const sessionBackup = require('./session-backup');
  try {
    const result = await sessionBackup.restoreSession();
    if (result.success) {
      await ctx.replyWithMarkdown(`✅ Restaurada (${result.fileCount} archivos).\n💡 Reinicia el bot.`);
    } else {
      await ctx.replyWithMarkdown(`⚠️ Falló: ${result.reason}`);
    }
  } catch (e) {
    await ctx.reply(`❌ ${e.message}`);
  }
});

bot.action('session_logout', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown('⚠️ Usa `/session logout` para confirmar.');
});

bot.action('session_logout_confirm', async (ctx) => {
  await ctx.answerCbQuery('Borrando...');
  const sessionBackup = require('./session-backup');
  try {
    await sessionBackup.deleteSession();
    await ctx.editMessageText('✅ Sesión eliminada. Reinicia el bot.');
  } catch (e) {
    await ctx.reply(`❌ ${e.message}`);
  }
});

bot.action('session_logout_cancel', async (ctx) => {
  await ctx.answerCbQuery('Cancelado');
  await ctx.editMessageText('❌ Cancelado.');
});

// ══════════════════════════════════════════
// MANEJO DE ERRORES
// ══════════════════════════════════════════

bot.catch((err, ctx) => {
  dbg('BOT', `❌ Error: ${err.message}`);
  console.error('Error en bot:', err);
  try { ctx.reply('❌ Error inesperado.'); } catch {}
});

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = bot;
