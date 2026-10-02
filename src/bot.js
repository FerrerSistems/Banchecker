/**
 * BOT DE TELEGRAM — VERSIÓN FINAL
 * - NO envía QR automáticamente
 * - /session muestra estado y envía QR solo si el usuario lo pide
 * - HTML en lugar de Markdown
 * - Full try/catch
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
  if (!userId) return;

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
    return ctx.reply('❌ Error verificando autorización.').catch(() => {});
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

    await ctx.replyWithHTML(msg, Markup.inlineKeyboard(buttons));
  } catch (e) {
    dbg('BOT', `Error en /start: ${e.message}`);
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
      '❌ <code>/status +51 999-999-999</code>\n\n' +
      '🌎 <b>DDI comunes:</b>\n' +
      '🇵🇪 Perú: 51 | 🇲🇽 México: 52 | 🇦🇷 Argentina: 54\n' +
      '🇨🇴 Colombia: 57 | 🇨🇱 Chile: 56 | 🇪🇸 España: 34\n\n' +
      '🔹 <b>VERIFICACIÓN</b>\n' +
      '<code>/status 51 999999999</code>\n' +
      '• ✅ Activo\n' +
      '• ⚠️ Baneo temporal\n' +
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
      '<code>/session</code> — Gestión de sesiones WhatsApp';

    await ctx.replyWithHTML(msg);
  } catch (e) {
    dbg('BOT', `Error en /help: ${e.message}`);
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
        'Incluye el DDI.\n\n' +
        'Ejemplo: <code>/status 51 999999999</code>'
      );
    }

    const { phone, pretty } = parsed;

    processingMsg = await ctx.reply(
      `🔄 Verificando ${pretty}... Esto puede tomar hasta 30 segundos.`
    );

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
      `💬 ${esc(result.message)}\n` +
      `⏰ ${esc(new Date().toLocaleString('es-ES'))}`;

    await ctx.telegram.editMessageText(
      ctx.chat.id, processingMsg.message_id, undefined, msg,
      { parse_mode: 'HTML' }
    ).catch(() => ctx.replyWithHTML(msg).catch(() => {}));
  } catch (e) {
    dbg('BOT', `Error en /status: ${e.message}`);
    const errMsg = `❌ <b>Error:</b> ${esc(e.message)}`;
    if (processingMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, processingMsg.message_id, undefined, errMsg,
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
        'Ejemplo: <code>/monitoradd 51 999999999</code>'
      );
    }

    const { phone, pretty } = parsed;

    processingMsg = await ctx.reply(`🔄 Verificando ${pretty}...`);

    const check = await whatsapp.checkNumberStatus(phone);

    if (check.status !== 'ACTIVE' && check.status !== 'VERIFY') {
      return ctx.telegram.editMessageText(
        ctx.chat.id, processingMsg.message_id, undefined,
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
        case 'already_exists': reason = 'El número ya está en tu lista.'; break;
        case 'already_suspended': reason = 'El número ya está marcado como suspendido.'; break;
      }

      return ctx.telegram.editMessageText(
        ctx.chat.id, processingMsg.message_id, undefined,
        `⚠️ <b>No se pudo agregar</b>\n\n${esc(reason)}`,
        { parse_mode: 'HTML' }
      );
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, processingMsg.message_id, undefined,
      `✅ <b>Agregado a monitoreo</b>\n\n` +
      `📱 <code>${esc(pretty)}</code>\n` +
      `⏰ Verificación cada 60s\n\n` +
      `💡 Recibirás notificación si es baneado.`,
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    dbg('BOT', `Error en /monitoradd: ${e.message}`);
    const errMsg = `❌ <b>Error:</b> ${esc(e.message)}`;
    if (processingMsg) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, processingMsg.message_id, undefined, errMsg,
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

  let sessionBackup;
  try {
    sessionBackup = require('./session-backup');
  } catch (e) {
    return ctx.reply(`❌ Error interno: ${e.message}`);
  }

  try {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const subcommand = args[0]?.toLowerCase();

    // ══════════════════════════════════════════
    // /session (estado + QR si hace falta)
    // ══════════════════════════════════════════
    if (!subcommand) {
      const hasLocal = sessionBackup.hasLocalSession();
      const waReady = whatsapp.isReady();
      const info = whatsapp.getClient()?.info;
      const hasQR = whatsapp.hasQR();
      const diag = whatsapp.getDiagnostics();

      // ────────────────────────────────────────
      // CASO 1: NO conectado, NO QR → generar QR
      // ─────────────────────────────────────────
      if (!waReady && !hasQR) {
        const msg = await ctx.reply(
          '🔄 Generando QR... Esto puede tardar 1-2 minutos.\n\n' +
          '⚠️ Si ya tenías una sesión, se va a borrar.\n\n' +
          '⏳ Espera...'
        );

        try {
          await whatsapp.restartForQR();

          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            '✅ Cliente reiniciado.\n\n' +
            '⏳ Esperando que WhatsApp genere el QR...\n\n' +
            '💡 Envía /session de nuevo en 30 segundos para recibir el QR.',
            { parse_mode: 'HTML' }
          );
        } catch (e) {
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `❌ Error al generar QR: ${esc(e.message)}`,
            { parse_mode: 'HTML' }
          );
        }
        return;
      }

      // ────────────────────────────────────────
      // CASO 2: NO conectado, SÍ hay QR → enviarlo
      // ─────────────────────────────────────────
      if (!waReady && hasQR) {
        const buffer = whatsapp.getQRBuffer();

        if (buffer) {
          try {
            await ctx.replyWithPhoto(
              { source: buffer },
              {
                caption:
                  `📲 <b>QR PENDIENTE</b>\n\n` +
                  `Escanea con WhatsApp:\n` +
                  `1️⃣ Abre WhatsApp\n` +
                  `2️⃣ Ajustes → Dispositivos vinculados\n` +
                  `3️⃣ Vincular un dispositivo\n\n` +
                  `⚠️ Expira en ~20 segundos. Si expira, usa /session de nuevo.`,
                parse_mode: 'HTML',
              }
            );
          } catch (e) {
            await ctx.reply(`⚠️ No se pudo enviar el QR: ${e.message}`);
          }
        } else {
          await ctx.reply('⚠️ QR no disponible. Usa /session logout y /session de nuevo.');
        }
        return;
      }

      // ────────────────────────────────────────
      // CASO 3: Conectado → mostrar estado completo
      // ─────────────────────────────────────────
      const lines = [
        '🔐 <b>ESTADO DE SESIÓN</b>',
        '',
        `📱 WhatsApp: ${waReady ? '✅ Conectado' : '❌ Desconectado'}`,
      ];

      if (info?.wid?.user) {
        lines.push(`📞 Número: <code>${esc(prettyPhone(info.wid.user))}</code>`);
        lines.push(`👤 Nombre: ${esc(info.pushname || 'N/A')}`);
      }

      lines.push(`💾 Sesión local: ${hasLocal ? '✅' : '❌'}`);

      try {
        const remoteInfo = await sessionBackup.getRemoteBackupInfo();
        if (remoteInfo) {
          const phoneLabel = remoteInfo.phone ? prettyPhone(remoteInfo.phone) : 'Legacy';
          lines.push(`☁️ Backup GitHub: ✅ ${esc(phoneLabel)}`);
        } else {
          lines.push(`☁️ Backup GitHub: ❌`);
        }
      } catch (e) {
        lines.push(`☁️ Backup GitHub: ⚠️`);
      }

      try {
        const sessions = await sessionBackup.listSessions();
        lines.push(`📦 Sesiones guardadas: ${sessions.length}`);
      } catch (e) {}

      lines.push('');
      lines.push('📋 <b>Subcomandos:</b>');
      lines.push('<code>/session list</code> — Ver sesiones');
      lines.push('<code>/session backup</code> — Subir a GitHub');
      lines.push('<code>/session restore</code> — Restaurar');
      lines.push('<code>/session logout</code> — Borrar sesión');

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('🔐 Generar QR', 'session_forceqr'),
          Markup.button.callback('📦 Ver sesiones', 'session_list'),
        ],
        [
          Markup.button.callback('☁️ Backup', 'session_backup'),
          Markup.button.callback('🔽 Restore', 'session_restore'),
        ],
        [Markup.button.callback('🚪 Logout', 'session_logout')],
      ]);

      await ctx.replyWithHTML(lines.join('\n'), keyboard);
      return;
    }

    // ══════════════════════════════════════════
    // /session list
    // ══════════════════════════════════════════
    if (subcommand === 'list') {
      try {
        const sessions = await sessionBackup.listSessions();

        if (sessions.length === 0) {
          return ctx.replyWithHTML(
            '📦 <b>No hay sesiones guardadas</b>\n\n' +
            '💡 Cuando conectes un WhatsApp, se guardará automáticamente.'
          );
        }

        const currentInfo = whatsapp.getClient()?.info;
        const currentPhone = currentInfo?.wid?.user;

        const list = sessions
          .map((s, i) => {
            const isCurrent = currentPhone && s.phone === currentPhone;
            const badge = isCurrent ? ' 🟢' : '';
            return `${i + 1}. <code>${esc(s.pretty)}</code>${badge}`;
          })
          .join('\n');

        const buttons = sessions.slice(0, 10).map(s => {
          const label = s.phone ? prettyPhone(s.phone) : 'Legacy';
          return [Markup.button.callback(`▶️ ${label}`, `sess_restore_${s.phone || 'legacy'}`)];
        });
        buttons.push([Markup.button.callback('❌ Cerrar', 'session_close')]);

        await ctx.replyWithHTML(
          `📦 <b>SESIONES GUARDADAS</b> (${sessions.length})\n\n${list}\n\n` +
          `🟢 = Activa\n\n💡 Toca una para restaurar:`,
          Markup.inlineKeyboard(buttons)
        );
      } catch (e) {
        dbg('BOT', `Error en /session list: ${e.message}`);
        await ctx.reply(`❌ Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    // ══════════════════════════════════════════
    // /session backup
    // ══════════════════════════════════════════
    if (subcommand === 'backup') {
      const msg = await ctx.reply('🔼 Subiendo sesión a GitHub...');

      try {
        const info = whatsapp.getClient()?.info;
        const phone = info?.wid?.user;
        const result = await sessionBackup.backupSession('Manual [bot]', phone);

        if (result.success) {
          const phoneLabel = result.phone ? prettyPhone(result.phone) : 'Legacy';
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `✅ <b>Backup completado</b>\n\n` +
            `📞 <code>${esc(phoneLabel)}</code>\n` +
            `📦 ${result.sizeMB.toFixed(2)} MB\n` +
            `📁 ${result.fileCount} archivos\n` +
            `☁️ <code>logs/${esc(result.filename)}</code>`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `⚠️ <b>No se pudo hacer backup</b>\n\n💡 ${esc(result.message || result.reason)}`,
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

    // ══════════════════════════════════════════
    // /session restore
    // ══════════════════════════════════════════
    if (subcommand === 'restore') {
      const msg = await ctx.reply('🔽 Restaurando desde GitHub...');

      try {
        const result = await sessionBackup.restoreSession();

        if (result.success) {
          const phoneLabel = result.filename
            ? (sessionBackup.phoneFromFilename(result.filename)
                ? prettyPhone(sessionBackup.phoneFromFilename(result.filename))
                : 'Legacy')
            : 'N/A';

          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `✅ <b>Sesión restaurada</b>\n\n` +
            `📞 ${esc(phoneLabel)}\n` +
            `📁 ${result.fileCount} archivos\n\n` +
            `💡 Reinicia el bot en Railway para aplicarla.`,
            { parse_mode: 'HTML' }
          );
        } else {
          await ctx.telegram.editMessageText(
            ctx.chat.id, msg.message_id, undefined,
            `⚠️ <b>No se pudo restaurar</b>\n\n💡 ${esc(result.message || result.reason)}`,
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

    // ══════════════════════════════════════════
    // /session logout
    // ══════════════════════════════════════════
    if (subcommand === 'logout') {
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback('⚠️ SÍ, borrar todo', 'session_logout_confirm'),
          Markup.button.callback('❌ Cancelar', 'session_logout_cancel'),
        ],
      ]);

      return ctx.replyWithHTML(
        '⚠️ <b>¿Seguro?</b>\n\n' +
        'Borrará TODAS las sesiones (local + GitHub).\n' +
        'Necesitarás escanear un QR nuevo.\n\n' +
        '¿Continuar?',
        keyboard
      );
    }

    return ctx.replyWithHTML(
      '❌ Subcomando desconocido.\n\n' +
      'Usa: <code>/session</code>, <code>/session list</code>, ' +
      '<code>/session backup</code>, <code>/session restore</code>, ' +
      '<code>/session logout</code>'
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
      '🔍 <b>Verificar número</b>\n\n<code>/status 51 999999999</code>'
    );
  } catch (e) {}
});

bot.action('help_monitor', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '➕ <b>Monitorear</b>\n\n<code>/monitoradd 51 999999999</code>\n\n💡 Cada 60s.'
    );
  } catch (e) {}
});

bot.action('help_list', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '📋 <b>Listas</b>\n\n<code>/list</code> — Monitoreados\n<code>/listban</code> — Baneados'
    );
  } catch (e) {}
});

bot.action('help_general', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML('ℹ️ Usa <code>/help</code>.');
  } catch (e) {}
});

bot.action('help_session', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
      '🔐 <b>Sesión WhatsApp</b>\n\n' +
      '<code>/session</code> — Estado y QR\n' +
      '<code>/session list</code> — Ver sesiones\n' +
      '<code>/session backup</code> — Subir\n' +
      '<code>/session restore</code> — Restaurar\n' +
      '<code>/session logout</code> — Borrar'
    );
  } catch (e) {}
});

// ══════════════════════════════════════════
// ACCIÓN: Generar QR
// ══════════════════════════════════════════

bot.action('session_forceqr', async (ctx) => {
  try {
    if (ctx.from.id !== config.telegram.adminId) {
      return ctx.answerCbQuery('Solo admin');
    }

    await ctx.answerCbQuery('Reiniciando...');

    const msg = await ctx.reply(
      '🔄 Reiniciando cliente...\n\n' +
      '⏳ Espera 30 segundos y luego envía /session para recibir el QR.'
    );

    try {
      await whatsapp.restartForQR();
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        '✅ Cliente reiniciado.\n\n' +
        '💡 Envía /session en 30 segundos para recibir el QR.',
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
  }
});

// ══════════════════════════════════════════
// ACCIÓN: Listar sesiones
// ══════════════════════════════════════════

bot.action('session_list', async (ctx) => {
  try {
    if (ctx.from.id !== config.telegram.adminId) {
      return ctx.answerCbQuery('Solo admin');
    }

    await ctx.answerCbQuery('Listando...');
    const sessionBackup = require('./session-backup');

    const sessions = await sessionBackup.listSessions();

    if (sessions.length === 0) {
      return ctx.replyWithHTML(
        '📦 <b>No hay sesiones guardadas</b>\n\n' +
        '💡 Cuando conectes un WhatsApp, se guardará automáticamente.'
      );
    }

    const currentInfo = whatsapp.getClient()?.info;
    const currentPhone = currentInfo?.wid?.user;

    const list = sessions
      .map((s, i) => {
        const isCurrent = currentPhone && s.phone === currentPhone;
        const badge = isCurrent ? ' 🟢' : '';
        return `${i + 1}. <code>${esc(s.pretty)}</code>${badge}`;
      })
      .join('\n');

    const buttons = sessions.slice(0, 10).map(s => {
      const label = s.phone ? prettyPhone(s.phone) : 'Legacy';
      return [Markup.button.callback(`▶️ ${label}`, `sess_restore_${s.phone || 'legacy'}`)];
    });
    buttons.push([Markup.button.callback('❌ Cerrar', 'session_close')]);

    await ctx.replyWithHTML(
      `📦 <b>SESIONES GUARDADAS</b> (${sessions.length})\n\n${list}\n\n` +
      `🟢 = Activa\n\n💡 Toca una para restaurar:`,
      Markup.inlineKeyboard(buttons)
    );
  } catch (e) {
    dbg('BOT', `Error session_list: ${e.message}`);
    await ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

// ══════════════════════════════════════════
// ACCIÓN: Restaurar sesión específica
// ══════════════════════════════════════════

bot.action(/^sess_restore_(.+)$/, async (ctx) => {
  try {
    if (ctx.from.id !== config.telegram.adminId) {
      return ctx.answerCbQuery('Solo admin');
    }

    const phoneRaw = ctx.match[1];
    const phone = phoneRaw === 'legacy' ? null : phoneRaw;

    await ctx.answerCbQuery('Restaurando...');
    const sessionBackup = require('./session-backup');
    const label = phone ? prettyPhone(phone) : 'Legacy';

    const msg = await ctx.reply(`🔄 Restaurando ${label}...`);
    const result = await sessionBackup.restoreSession(phone);

    if (result.success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `✅ <b>Restaurada</b>\n\n` +
        `📞 ${esc(label)}\n` +
        `📁 ${result.fileCount} archivos\n` +
        `📦 <code>${esc(result.filename)}</code>\n\n` +
        `⚠️ Reinicia el bot en Railway para usarla.`,
        { parse_mode: 'HTML' }
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id, msg.message_id, undefined,
        `⚠️ <b>No se pudo restaurar</b>\n\n💡 ${esc(result.message || result.reason)}`,
        { parse_mode: 'HTML' }
      );
    }
  } catch (e) {
    dbg('BOT', `Error restaurando: ${e.message}`);
    await ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

// ══════════════════════════════════════════
// ACCIÓN: Cerrar
// ══════════════════════════════════════════

bot.action('session_close', async (ctx) => {
  try {
    await ctx.answerCbQuery('Cerrado');
    await ctx.deleteMessage().catch(() => {});
  } catch (e) {}
});

// ══════════════════════════════════════════
// ACCIÓN: Backup
// ══════════════════════════════════════════

bot.action('session_backup', async (ctx) => {
  try {
    if (ctx.from.id !== config.telegram.adminId) {
      return ctx.answerCbQuery('Solo admin');
    }

    await ctx.answerCbQuery('Backup...');
    const sessionBackup = require('./session-backup');
    const info = whatsapp.getClient()?.info;
    const phone = info?.wid?.user;

    const result = await sessionBackup.backupSession('Backup botón [bot]', phone);

    if (result.success) {
      const phoneLabel = result.phone ? prettyPhone(result.phone) : 'Legacy';
      await ctx.replyWithHTML(
        `✅ <b>Backup OK</b>\n\n📞 ${esc(phoneLabel)}\n📦 ${result.sizeMB.toFixed(2)} MB`
      );
    } else {
      await ctx.replyWithHTML(
        `⚠️ <b>No se pudo</b>\n\n💡 ${esc(result.message || result.reason)}`
      );
    }
  } catch (e) {
    dbg('BOT', `Error session_backup: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// ACCIÓN: Restore genérico
// ══════════════════════════════════════════

bot.action('session_restore', async (ctx) => {
  try {
    if (ctx.from.id !== config.telegram.adminId) {
      return ctx.answerCbQuery('Solo admin');
    }

    await ctx.answerCbQuery('Restaurando...');
    const sessionBackup = require('./session-backup');
    const result = await sessionBackup.restoreSession();

    if (result.success) {
      await ctx.replyWithHTML(
        `✅ Restaurada (${result.fileCount} archivos)\n⚠️ Reinicia el bot.`
      );
    } else {
      await ctx.replyWithHTML(
        `⚠️ <b>No se pudo</b>\n\n💡 ${esc(result.message || result.reason)}`
      );
    }
  } catch (e) {
    dbg('BOT', `Error session_restore: ${e.message}`);
  }
});

// ══════════════════════════════════════════
// ACCIÓN: Logout
// ══════════════════════════════════════════

bot.action('session_logout', async (ctx) => {
  try {
    if (ctx.from.id !== config.telegram.adminId) {
      return ctx.answerCbQuery('Solo admin');
    }

    await ctx.answerCbQuery();

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback('⚠️ SÍ, borrar todo', 'session_logout_confirm'),
        Markup.button.callback('❌ Cancelar', 'session_logout_cancel'),
      ],
    ]);

    await ctx.replyWithHTML(
      '⚠️ <b>¿Seguro?</b>\n\n' +
      'Borrará TODAS las sesiones.\n\n' +
      '¿Continuar?',
      keyboard
    );
  } catch (e) {}
});

bot.action('session_logout_confirm', async (ctx) => {
  try {
    if (ctx.from.id !== config.telegram.adminId) {
      return ctx.answerCbQuery('Solo admin');
    }

    await ctx.answerCbQuery('Borrando...');
    const sessionBackup = require('./session-backup');
    await sessionBackup.deleteSession();
    await ctx.editMessageText('✅ Todo eliminado. Reinicia el bot.').catch(() => {});
  } catch (e) {
    dbg('BOT', `Error logout_confirm: ${e.message}`);
    await ctx.reply(`❌ ${e.message}`).catch(() => {});
  }
});

bot.action('session_logout_cancel', async (ctx) => {
  try {
    await ctx.answerCbQuery('Cancelado');
    await ctx.editMessageText('❌ Cancelado.').catch(() => {});
  } catch (e) {}
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
