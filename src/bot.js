/**
 * BOT DE TELEGRAM — VERSIÓN COMPLETA
 * HTML en lugar de Markdown, try/catch en todo, /session fuerza QR
 */

const { Telegraf, Markup } = require('telegraf');
const config = require('./config');
const { dbg } = config;
const github = require('./github');
const monitor = require('./monitor');
const whatsapp = require('./whatsapp');

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

function parsePhone(args) {
  if (!args || args.length === 0) return null;

  let ddi = '';
  let number = '';

  if (args.length >= 2) {
    ddi = args[0].replace(/\D/g, '');
    number = args[1].replace(/\D/g, '');
  } else {
    const raw = args[0].replace(/\D/g, '');
    if (raw.length < 8) return null;

    if (raw.length >= 12) {
      ddi = raw.substring(0, 3);
      number = raw.substring(3);
    } else {
      ddi = raw.substring(0, 2);
      number = raw.substring(2);
    }
  }

  if (!ddi || !number || number.length < 6) return null;

  return {
    ddi,
    number,
    phone: `${ddi}${number}`,
    pretty: `+${ddi} ${number}`,
  };
}

function prettyPhone(raw) {
  if (!raw) return 'N/A';
  const ddi = raw.length >= 12 ? raw.substring(0, 3) : raw.substring(0, 2);
  const number = raw.substring(ddi.length);
  return `+${ddi} ${number}`;
}

// ══════════════════════════════════════════
// INICIALIZAR BOT
// ══════════════════════════════════════════

const bot = new Telegraf(config.telegram.token);
dbg('BOT', 'Bot inicializado');

// ══════════════════════════════════════════
// MIDDLEWARE DE AUTENTICACIÓN
// ══════════════════════════════════════════

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();

  if (!userId) {
    dbg('BOT', 'Usuario sin ID, ignorando');
    return;
  }

  if (ctx.from.id === config.telegram.adminId) {
    return next();
  }

  try {
    const auth = await github.isUserAuthorized(userId);

    if (!auth.authorized) {
      const msg =
        '🔒 <b>ACCESO DENEGADO</b>\n\n' +
        `❌ ${esc(auth.reason)}\n\n` +
        '💡 Solicita acceso al administrador.\n' +
        `📌 Tu ID: <code>${esc(userId)}</code>`;

      return ctx.replyWithHTML(msg);
    }

    return next();
  } catch (e) {
    dbg('BOT', `Error verificando auth: ${e.message}`);
    return ctx.reply('❌ Error verificando autorización. Intenta más tarde.');
  }
});

// ══════════════════════════════════════════
// /start
// ══════════════════════════════════════════

bot.start(async (ctx) => {
  try {
    const userId = ctx.from.id;
    const isAdmin = userId === config.telegram.adminId;
    dbg('BOT', `/start de ${userId}`);

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

    const msg =
      '👋 <b>¡Bienvenido a BanChecker Bot!</b>\n\n' +
      '🔍 Verifico si números de WhatsApp están activos o baneados.\n\n' +
      '📌 <b>Comandos:</b>\n' +
      '<code>/status &lt;DDI&gt; &lt;NÚMERO&gt;</code> — Verifica un número\n' +
      '<code>/monitoradd &lt;DDI&gt; &lt;NÚMERO&gt;</code> — Monitorea\n' +
      '<code>/list</code> — Tus números monitoreados\n' +
      '<code>/listban</code> — Números baneados\n' +
      '<code>/help</code> — Ayuda completa\n' +
      (isAdmin ? '<code>/session</code> — Gestión de sesión\n' : '') +
      '\n' +
      '💡 <b>Ejemplo:</b> <code>/status 51 999999999</code>\n\n' +
      `🆔 Tu ID: <code>${esc(userId)}</code>`;

    await ctx.replyWithHTML(msg, keyboard);
  } catch (e) {
    dbg('BOT', `Error en /start: ${e.message}`);
    console.error(e);
  }
});

// ══════════════════════════════════════════
// /help
// ══════════════════════════════════════════

bot.help(async (ctx) => {
  try {
    dbg('BOT', `/help de ${ctx.from.id}`);

    const msg =
      '📖 <b>AYUDA COMPLETA</b>\n\n' +
      '🔹 <b>FORMATO DE NÚMEROS</b>\n' +
      'Usa: <code>&lt;DDI&gt; &lt;NÚMERO&gt;</code> (con espacio)\n' +
      'O todo junto: <code>&lt;DDI&gt;&lt;NÚMERO&gt;</code>\n\n' +
      '✅ <code>/status 51 999999999</code>\n' +
      '✅ <code>/status 51999999999</code>\n' +
      '❌ <code>/status +51 999-999-999</code>\n' +
      '❌ <code>/status 999999999</code> (sin DDI)\n\n' +
      '🌎 <b>DDI comunes:</b>\n' +
      '🇵🇪 Perú: 51 | 🇲🇽 México: 52 | 🇦🇷 Argentina: 54\n' +
      '🇨🇴 Colombia: 57 | 🇨🇱 Chile: 56 | 🇪🇸 España: 34\n\n' +
      '🔹 <b>VERIFICACIÓN</b>\n' +
      '<code>/status 51 999999999</code>\n' +
      '• ✅ Activo\n' +
      '• ⚠️ Baneo temporal (solicitar revisión)\n' +
      '• 🚫 Baneo por spam\n' +
      '• ❌ Baneo permanente\n\n' +
      '🔹 <b>MONITOREO</b>\n' +
      '<code>/monitoradd 51 999999999</code>\n' +
      'Verificación cada 60 segundos.\n' +
      '<code>/list</code> — Ver monitoreados\n' +
      '<code>/listban</code> — Ver baneados\n\n' +
      '🔹 <b>ADMIN</b>\n' +
      '<code>/add &lt;id&gt; &lt;duración&gt;</code> — Autorizar (ej: 7d, 2h, 30m)\n' +
      '<code>/remove &lt;id&gt;</code> — Eliminar usuario\n' +
      '<code>/session</code> — Gestión de sesión WhatsApp';

    await ctx.replyWithHTML(msg);
  } catch (e) {
    dbg('BOT', `Error en /help: ${e.message}`);
    console.error(e);
    await ctx.reply('❌ Error mostrando ayuda.').catch(() => {});
  }
});

// ══════════════════════════════════════════
// /status
// ══════════════════════════════════════════

bot.command('status', async (ctx) => {
  const userId = ctx.from.id;
  dbg('BOT', `/status de ${userId}`);

  let processingMsg = null;

  try {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length === 0) {
      return ctx.replyWithHTML(
        '❌ <b>Uso incorrecto</b>\n\n' +
        '<code>/status &lt;DDI&gt; &lt;NÚMERO&gt;</code>\n\n' +
        'Ejemplos:\n' +
        '<code>/status 51 999999999</code>\n' +
        '<code>/status 51999999999</code>'
      );
    }

    const parsed = parsePhone(args);

    if (!parsed) {
      return ctx.replyWithHTML(
        '❌ <b>Número inválido</b>\n\n' +
        'Incluye el DDI (código de país).\n\n' +
        'Ejemplo: <code>/status 51 999999999</code>'
      );
    }

    const { phone, pretty } = parsed;

    processingMsg = await ctx.reply(
      `🔄 Verificando ${pretty}... Esto puede tomar unos segundos.`
    );

    dbg('BOT', `Verificando ${phone}...`);
    const result = await whatsapp.checkNumberStatus(phone);
    dbg('BOT', `Resultado: ${result.status}`);

    let emoji = '❓';
    let statusText = 'Desconocido';

    switch (result.status) {
      case 'ACTIVE':        emoji = '✅'; statusText = 'Activo'; break;
      case 'TEMPORARY_BAN': emoji = '⚠️'; statusText = 'Baneo temporal'; break;
      case 'SPAM_BAN':      emoji = '🚫'; statusText = 'Baneo por spam'; break;
      case 'PERMANENT_BAN': emoji = '❌'; statusText = 'Baneo permanente'; break;
      case 'VERIFY':        emoji = '🔄'; statusText = 'Verificar'; break;
      case 'ERROR':         emoji = '💥'; statusText = 'Error'; break;
    }

    const msg =
      `${emoji} <b>RESULTADO</b>\n\n` +
      `📱 Número: <code>${esc(pretty)}</code>\n` +
      `📊 Estado: <b>${esc(statusText)}</b>\n` +
      `💬 Mensaje: ${esc(result.message)}\n` +
      `⏰ ${esc(new Date().toLocaleString('es-ES'))}`;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      msg,
      { parse_mode: 'HTML' }
    ).catch(async () => {
      await ctx.replyWithHTML(msg);
    });
  } catch (e) {
    dbg('BOT', `Error en /status: ${e.message}`);
    console.error(e);

    const errMsg = `❌ <b>Error:</b> ${esc(e.message)}`;

    if (processingMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        errMsg,
        { parse_mode: 'HTML' }
      ).catch(() => ctx.replyWithHTML(errMsg).catch(() => {}));
    } else {
      await ctx.replyWithHTML(errMsg).catch(() => {});
    }
  }
});

// ══════════════════════════════════════════
// /monitoradd
// ══════════════════════════════════════════

bot.command('monitoradd', async (ctx) => {
  const userId = ctx.from.id.toString();
  dbg('BOT', `/monitoradd de ${userId}`);

  let processingMsg = null;

  try {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length === 0) {
      return ctx.replyWithHTML(
        '❌ <b>Uso incorrecto</b>\n\n' +
        '<code>/monitoradd &lt;DDI&gt; &lt;NÚMERO&gt;</code>\n\n' +
        'Ejemplos:\n' +
        '<code>/monitoradd 51 999999999</code>\n' +
        '<code>/monitoradd 51999999999</code>\n\n' +
        '💡 Verificación cada 60 segundos.'
      );
    }

    const parsed = parsePhone(args);

    if (!parsed) {
      return ctx.replyWithHTML(
        '❌ <b>Número inválido</b>\n\n' +
        'Incluye el DDI.\n\n' +
        'Ejemplo: <code>/monitoradd 51 999999999</code>'
      );
    }

    const { phone, pretty } = parsed;

    processingMsg = await ctx.reply(`🔄 Verificando ${pretty}...`);

    const check = await whatsapp.checkNumberStatus(phone);

    if (check.status !== 'ACTIVE' && check.status !== 'VERIFY') {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `⚠️ <b>El número no está activo</b>\n\n` +
        `📊 Estado: ${esc(check.message)}\n\n` +
        `💡 No se puede monitorear un número baneado.`,
        { parse_mode: 'HTML' }
      );
    }

    const result = await monitor.addNumberToMonitor(userId, phone);

    if (!result.success) {
      let reason = 'Error desconocido';
      switch (result.reason) {
        case 'already_exists':
          reason = 'El número ya está en tu lista.';
          break;
        case 'already_suspended':
          reason = 'El número ya está marcado como suspendido.';
          break;
      }

      return ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        `⚠️ <b>No se pudo agregar</b>\n\n${esc(reason)}`,
        { parse_mode: 'HTML' }
      );
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `✅ <b>Agregado a monitoreo</b>\n\n` +
      `📱 <code>${esc(pretty)}</code>\n` +
      `⏰ Verificación cada 60s\n\n` +
      `💡 Recibirás notificación si es baneado.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    dbg('BOT', `Error en /monitoradd: ${e.message}`);
    console.error(e);

    const errMsg = `❌ <b>Error:</b> ${esc(e.message)}`;

    if (processingMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        processingMsg.message_id,
        undefined,
        errMsg,
        { parse_mode: 'HTML' }
      ).catch(() => ctx.replyWithHTML(errMsg).catch(() => {}));
    } else {
      await ctx.replyWithHTML(errMsg).catch(() => {});
    }
  }
});

// ══════════════════════════════════════════
// /list
// ══════════════════════════════════════════

bot.command('list', async (ctx) => {
  const userId = ctx.from.id.toString();
  dbg('BOT', `/list de ${userId}`);

  try {
    const numbers = await monitor.getUserMonitoredNumbers(userId);

    if (!numbers || numbers.length === 0) {
      return ctx.replyWithHTML(
        '📋 <b>Tu lista está vacía.</b>\n\n' +
        'Usa <code>/monitoradd 51 999999999</code> para agregar.'
      );
    }

    const list = numbers
      .map((n, i) => `${i + 1}. <code>${esc(prettyPhone(n))}</code>`)
      .join('\n');

    await ctx.replyWithHTML(
      `📋 <b>NÚMEROS MONITOREADOS</b>\n\n${list}\n\n` +
      `📊 Total: ${numbers.length}`
    );
  } catch (e) {
    dbg('BOT', `Error en /list: ${e.message}`);
    console.error(e);
    await ctx.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

// ══════════════════════════════════════════
// /listban
// ══════════════════════════════════════════

bot.command('listban', async (ctx) => {
  const userId = ctx.from.id.toString();
  dbg('BOT', `/listban de ${userId}`);

  try {
    const numbers = await monitor.getUserSuspendedNumbers(userId);

    if (!numbers || numbers.length === 0) {
      return ctx.replyWithHTML(
        '✅ <b>No hay números baneados.</b>\n\n' +
        'Todos tus números están activos.'
      );
    }

    const list = numbers
      .map((n, i) => `${i + 1}. <code>${esc(prettyPhone(n))}</code>`)
      .join('\n');

    await ctx.replyWithHTML(
      `🚫 <b>NÚMEROS BANEADOS</b>\n\n${list}\n\n` +
      `📊 Total: ${numbers.length}`
    );
  } catch (e) {
    dbg('BOT', `Error en /listban: ${e.message}`);
    console.error(e);
    await ctx.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

// ══════════════════════════════════════════
// /add (SOLO ADMIN)
// ══════════════════════════════════════════

bot.command('add', async (ctx) => {
  const userId = ctx.from.id;
  dbg('BOT', `/add de ${userId}`);

  if (userId !== config.telegram.adminId) {
    return ctx.replyWithHTML('⛔ <b>Solo admin.</b>');
  }

  try {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 2) {
      return ctx.replyWithHTML(
        '❌ <b>Uso:</b> <code>/add &lt;id&gt; &lt;duración&gt;</code>\n\n' +
        'Ejemplos:\n' +
        '<code>/add 123456789 7d</code> — 7 días\n' +
        '<code>/add 123456789 2h</code> — 2 horas\n' +
        '<code>/add 123456789 30m</code> — 30 minutos'
      );
    }

    const targetId = args[0].replace(/\D/g, '');
    const durationStr = args[1].toLowerCase();

    const match = durationStr.match(/^(\d+)([mhd])$/);
    if (!match) {
      return ctx.replyWithHTML('❌ Formato inválido. Usa: <code>30m</code>, <code>2h</code>, <code>7d</code>');
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    let durationMs = 0;
    switch (unit) {
      case 'm': durationMs = value * 60 * 1000; break;
      case 'h': durationMs = value * 60 * 60 * 1000; break;
      case 'd': durationMs = value * 24 * 60 * 60 * 1000; break;
    }

    const user = await github.addAuthorizedUser(targetId, durationMs);
    const expiry = new Date(user.expiresAt).toLocaleString('es-ES');

    await ctx.replyWithHTML(
      `✅ <b>Usuario autorizado</b>\n\n` +
      `🆔 <code>${esc(targetId)}</code>\n` +
      `⏰ Expira: ${esc(expiry)}\n` +
      `📅 Duración: ${esc(durationStr)}`
    );

    dbg('BOT', `Usuario ${targetId} autorizado por ${durationStr}`);
  } catch (e) {
    dbg('BOT', `Error en /add: ${e.message}`);
    console.error(e);
    await ctx.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

// ══════════════════════════════════════════
// /remove (SOLO ADMIN)
// ══════════════════════════════════════════

bot.command('remove', async (ctx) => {
  const userId = ctx.from.id;
  dbg('BOT', `/remove de ${userId}`);

  if (userId !== config.telegram.adminId) {
    return ctx.reply('⛔ Solo admin.');
  }

  try {
    const args = ctx.message.text.split(/\s+/).slice(1);

    if (args.length < 1) {
      return ctx.replyWithHTML('❌ Uso: <code>/remove &lt;id&gt;</code>');
    }

    const targetId = args[0].replace(/\D/g, '');
    await github.removeAuthorizedUser(targetId);

    await ctx.replyWithHTML(`✅ Usuario <code>${esc(targetId)}</code> eliminado.`);
  } catch (e) {
    dbg('BOT', `Error en /remove: ${e.message}`);
    console.error(e);
    await ctx.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

// ══════════════════════════════════════════
// /session (SOLO ADMIN)
// ══════════════════════════════════════════

bot.command('session', async (ctx) => {
  const userId = ctx.from.id;
  dbg('BOT', `/session de ${userId}`);

  if (userId !== config.telegram.adminId) {
    return ctx.reply('⛔ Solo admin.');
  }

  let sessionBackup, qrModule;
  try {
    sessionBackup = require('./session-backup');
    qrModule = require('./qr');
  } catch (e) {
    dbg('BOT', `Error importando módulos: ${e.message}`);
    return ctx.reply(`❌ Error interno: ${e.message}`);
  }

  try {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const subcommand = args[0]?.toLowerCase();

    // ══════════════════════════════════════════
    // /session (estado + QR automático)
    // ══════════════════════════════════════════
    if (!subcommand) {
      const hasLocal = sessionBackup.hasLocalSession();
      const waReady = whatsapp.isReady();
      const info = whatsapp.getClient()?.info;
      const hasQR = qrModule.hasQR();
      const diag = whatsapp.getDiagnostics();

      // SI NO ESTÁ CONECTADO NI HAY QR → FORZAR QR
      if (!waReady && !hasQR) {
        const msg = await ctx.reply(
          '🔄 Generando QR... Esto puede tardar 1-2 minutos.\n\n' +
          '⚠️ Si ya tenías una sesión, se va a borrar.\n\n' +
          '⏳ Espera...'
        );

        try {
          dbg('BOT', 'Forzando restart para generar QR...');
          await whatsapp.restartForQR();

          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            '✅ Cliente reiniciado.\n\n' +
            '⏳ Esperando que WhatsApp genere el QR...\n' +
            'Cuando aparezca, te lo enviaré automáticamente.\n\n' +
            'Si pasan 2 minutos sin respuesta, vuelve a usar /session.',
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          dbg('BOT', `Error forzando QR: ${e.message}`);
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `❌ Error al generar QR: ${esc(e.message)}`,
            { parse_mode: 'HTML' }
          );
        }
        return;
      }

      // ESTADO NORMAL
      const lines = [
        '🔐 <b>ESTADO DE SESIÓN</b>',
        '',
        `📱 WhatsApp: ${waReady ? '✅ Conectado' : '❌ Desconectado'}`,
        `🔧 Inicializando: ${diag.initializing ? '⏳ Sí' : 'No'}`,
        `📡 Último evento: <code>${esc(diag.lastEvent)}</code>`,
      ];

      if (diag.initElapsedSec) {
        lines.push(`⏱️ Tiempo init: ${diag.initElapsedSec}s`);
      }

      if (diag.initError) {
        lines.push(`❌ Error: ${esc(diag.initError)}`);
      }

      if (info?.wid?.user) {
        lines.push(`📞 Número: <code>${esc(prettyPhone(info.wid.user))}</code>`);
        lines.push(`👤 Nombre: ${esc(info.pushname || 'N/A')}`);
      }

      lines.push(`💾 Sesión local: ${hasLocal ? '✅' : '❌'}`);
      lines.push(`📲 QR pendiente: ${hasQR ? '✅' : '❌'}`);

      try {
        const remoteInfo = await sessionBackup.getRemoteBackupInfo();
        if (remoteInfo) {
          lines.push(`☁️ Backup GitHub: ✅ ${remoteInfo.sizeMB.toFixed(2)} MB`);
        } else {
          lines.push(`☁️ Backup GitHub: ❌`);
        }
      } catch (e) {
        lines.push(`☁️ Backup GitHub: ⚠️ Error`);
      }

      lines.push('');
      lines.push('📋 <b>Subcomandos:</b>');
      lines.push('<code>/session</code> — Ver estado (o generar QR)');
      lines.push('<code>/session backup</code> — Subir a GitHub');
      lines.push('<code>/session restore</code> — Restaurar desde GitHub');
      lines.push('<code>/session logout</code> — Borrar sesión');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔐 Generar QR', 'session_forceqr'),
          Markup.button.callback('☁️ Backup', 'session_backup'),
        ],
        [
          Markup.button.callback('🔽 Restore', 'session_restore'),
          Markup.button.callback('🚪 Logout', 'session_logout'),
        ],
      ]);

      await ctx.replyWithHTML(lines.join('\n'), keyboard);

      if (hasQR) {
        try {
          const qrBuffer = qrModule.getCurrentQRBuffer();
          if (qrBuffer) {
            await ctx.replyWithPhoto(
              { source: qrBuffer },
              {
                caption:
                  `📲 <b>QR PENDIENTE</b>\n\n` +
                  `⏰ ${esc(qrModule.getCurrentQRTime()?.toLocaleString('es-ES') || 'N/A')}\n\n` +
                  `Escanea con WhatsApp → Dispositivos vinculados`,
                parse_mode: 'HTML',
              }
            );
          }
        } catch (e) {
          dbg('BOT', `Error enviando QR: ${e.message}`);
        }
      }
      return;
    }

    // ── /session backup
    if (subcommand === 'backup') {
      const msg = await ctx.reply('🔼 Subiendo sesión a GitHub...');

      try {
        const result = await sessionBackup.backupSession('Manual backup [bot]');

        if (result.success) {
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `✅ <b>Backup completado</b>\n\n` +
            `📦 ${result.sizeMB.toFixed(2)} MB\n` +
            `📁 ${result.fileCount} archivos\n` +
            `☁️ <code>logs/session.zip</code>`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `⚠️ <b>Falló:</b> ${esc(result.reason)}${result.error ? '\n' + esc(result.error) : ''}`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (e) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          `❌ ${esc(e.message)}`, { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return;
    }

    // ── /session restore
    if (subcommand === 'restore') {
      const msg = await ctx.reply('🔽 Restaurando desde GitHub...');

      try {
        const result = await sessionBackup.restoreSession();

        if (result.success) {
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `✅ <b>Sesión restaurada</b>\n\n` +
            `📁 ${result.fileCount} archivos\n\n` +
            `💡 Reinicia el bot para aplicarla.`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `⚠️ <b>Falló:</b> ${esc(result.reason)}`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (e) {
        await ctx.telegram.editMessageText(
          ctx.chat.id, msg.message_id, undefined,
          `❌ ${esc(e.message)}`, { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return;
    }

    // ── /session logout
    if (subcommand === 'logout') {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('⚠️ SÍ, borrar', 'session_logout_confirm'),
          Markup.button.callback('❌ Cancelar', 'session_logout_cancel'),
        ],
      ]);

      return ctx.replyWithHTML(
        '⚠️ <b>¿Seguro?</b>\n\n' +
        'Borrará sesión local + GitHub.\n' +
        'Necesitarás nuevo QR.\n\n' +
        '¿Continuar?',
        keyboard
      );
    }

    return ctx.replyWithHTML(
      '❌ Subcomando desconocido.\n\n' +
      'Usa: <code>/session</code>, <code>/session backup</code>, ' +
      '<code>/session restore</code>, <code>/session logout</code>'
    );
  } catch (e) {
    dbg('BOT', `Error en /session: ${e.message}`);
    console.error(e);
    await ctx.reply(`❌ Error: ${e.message}`).catch(() => {});
  }
});

// ══════════════════════════════════════════
// ACCIONES DE BOTONES
// ══════════════════════════════════════════

bot.action('help_status', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '🔍 <b>Verificar número</b>\n\n' +
      '<code>/status 51 999999999</code>\n\n' +
      '💡 DDI + número, con espacio o junto.'
    );
  } catch (e) {
    dbg('BOT', `Error help_status: ${e.message}`);
  }
});

bot.action('help_monitor', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '➕ <b>Monitorear</b>\n\n' +
      '<code>/monitoradd 51 999999999</code>\n\n' +
      '💡 Verificación cada 60s.'
    );
  } catch (e) {
    dbg('BOT', `Error help_monitor: ${e.message}`);
  }
});

bot.action('help_list', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '📋 <b>Listas</b>\n\n' +
      '<code>/list</code> — Monitoreados\n' +
      '<code>/listban</code> — Baneados'
    );
  } catch (e) {
    dbg('BOT', `Error help_list: ${e.message}`);
  }
});

bot.action('help_general', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML('ℹ️ Usa <code>/help</code> para la ayuda completa.');
  } catch (e) {
    dbg('BOT', `Error help_general: ${e.message}`);
  }
});

bot.action('help_session', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '🔐 <b>Sesión WhatsApp</b>\n\n' +
      '<code>/session</code> — Estado y QR\n' +
      '<code>/session backup</code> — Subir a GitHub\n' +
      '<code>/session restore</code> — Restaurar\n' +
      '<code>/session logout</code> — Borrar'
    );
  } catch (e) {
    dbg('BOT', `Error help_session: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// ACCIÓN: Forzar QR
// ══════════════════════════════════════════

bot.action('session_forceqr', async (ctx) => {
  try {
    await ctx.answerCbQuery('Reiniciando cliente...');

    const msg = await ctx.reply(
      '🔄 Reiniciando cliente de WhatsApp...\n\n' +
      '⏳ Esto puede tardar 1-2 minutos.\n' +
      'Cuando el QR esté listo, te lo enviaré automáticamente.'
    );

    try {
      await whatsapp.restartForQR();

      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        '✅ Cliente reiniciado.\n\n' +
        '⏳ Esperando QR de WhatsApp...\n\n' +
        'Debería llegarte en 1-2 minutos.',
        { parse_mode: 'HTML' }
      );
    } catch (e) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `❌ Error: ${esc(e.message)}`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    dbg('BOT', `Error session_forceqr: ${e.message}`);
    await ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

bot.action('session_backup', async (ctx) => {
  try {
    await ctx.answerCbQuery('Iniciando backup...');
    const sessionBackup = require('./session-backup');

    const result = await sessionBackup.backupSession('Backup via botón [bot]');

    if (result.success) {
      await ctx.replyWithHTML(
        `✅ Backup: ${result.sizeMB.toFixed(2)} MB (${result.fileCount} archivos)`
      );
    } else {
      await ctx.replyWithHTML(`⚠️ Falló: ${esc(result.reason)}`);
    }
  } catch (e) {
    dbg('BOT', `Error session_backup: ${e.message}`);
    await ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

bot.action('session_restore', async (ctx) => {
  try {
    await ctx.answerCbQuery('Restaurando...');
    const sessionBackup = require('./session-backup');

    const result = await sessionBackup.restoreSession();

    if (result.success) {
      await ctx.replyWithHTML(
        `✅ Restaurada (${result.fileCount} archivos).\n💡 Reinicia el bot.`
      );
    } else {
      await ctx.replyWithHTML(`⚠️ Falló: ${esc(result.reason)}`);
    }
  } catch (e) {
    dbg('BOT', `Error session_restore: ${e.message}`);
    await ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

bot.action('session_logout', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML('⚠️ Usa <code>/session logout</code> para confirmar.');
  } catch (e) {
    dbg('BOT', `Error session_logout: ${e.message}`);
  }
});

bot.action('session_logout_confirm', async (ctx) => {
  try {
    await ctx.answerCbQuery('Borrando...');
    const sessionBackup = require('./session-backup');
    await sessionBackup.deleteSession();
    await ctx.editMessageText('✅ Sesión eliminada. Reinicia el bot.').catch(() => {});
  } catch (e) {
    dbg('BOT', `Error session_logout_confirm: ${e.message}`);
    await ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

bot.action('session_logout_cancel', async (ctx) => {
  try {
    await ctx.answerCbQuery('Cancelado');
    await ctx.editMessageText('❌ Cancelado.').catch(() => {});
  } catch (e) {
    dbg('BOT', `Error session_logout_cancel: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// MANEJO DE ERRORES GLOBAL
// ══════════════════════════════════════════

bot.catch((err, ctx) => {
  dbg('BOT', `❌ Error no manejado: ${err.message}`);
  console.error('Error en bot:', err);

  try {
    if (ctx) {
      ctx.reply('❌ Error inesperado. Intenta de nuevo.').catch(() => {});
    }
  } catch {}
});

// ══════════════════════════════════════════
// EXPORTAR
// ══════════════════════════════════════════

module.exports = bot;
