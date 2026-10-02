/**
 * CONFIGURACIÓN GLOBAL DEL BOT
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config();

const requiredEnvVars = [
  'TELEGRAM_BOT_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'ADMIN_TELEGRAM_ID',
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error('\n❌ ERROR: Faltan variables de entorno obligatorias:');
  missingVars.forEach(v => console.error(`   - ${v}`));
  console.error('\n   Revisa tu archivo .env o las variables en Railway.\n');
  process.exit(1);
}

module.exports = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    adminId: parseInt(process.env.ADMIN_TELEGRAM_ID, 10),
  },
  github: {
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || 'main',
    logsPath: process.env.GITHUB_LOGS_PATH || 'logs',
  },
  whatsapp: {
    chromePath: process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || null,
    sessionPath: path.join(__dirname, '..', 'wa_session'),
    sessionId: 'ghost',
  },
  monitor: {
    intervalMs: 60 * 1000,
  },
  debug: process.env.DEBUG === 'true',
  paths: {
    logs: path.join(__dirname, '..', 'logs'),
    session: path.join(__dirname, '..', 'wa_session'),
  },
};

const dbg = (tag, msg, data) => {
  if (!module.exports.debug) return;
  const extra = data !== undefined ? ' | ' + JSON.stringify(data) : '';
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}${extra}`);
};

module.exports.dbg = dbg;

if (!fs.existsSync(module.exports.paths.logs)) {
  fs.mkdirSync(module.exports.paths.logs, { recursive: true });
  dbg('INIT', 'Directorio logs creado');
}

if (!fs.existsSync(module.exports.paths.session)) {
  fs.mkdirSync(module.exports.paths.session, { recursive: true });
  dbg('INIT', 'Directorio wa_session creado');
}
