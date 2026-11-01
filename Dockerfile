FROM node:22-bookworm-slim

# Variables básicas (NO tokens aquí: esos van en Railway → Variables)
ENV NODE_ENV=production \
    TZ=America/Lima \
    DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium

# Paquetes base + Chromium (necesario para WhatsApp/Puppeteer) + fuentes
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    git \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiamos dependencias primero (aprovecha la caché de Docker)
COPY package*.json ./

# Instalamos dependencias de producción
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copiamos el resto del código con el dueño correcto
COPY --chown=node:node . .

# Carpetas necesarias y permisos
RUN mkdir -p /app/wa_session /app/tokens /app/logs \
    && chown -R node:node /app

# Script de preflight: diagnóstico al arrancar (no imprime valores de tokens)
COPY --chown=node:node <<'EOF' /app/preflight.js
'use strict';

const fs = require('fs');

console.log('══════════════════════════════════════════════════');
console.log('🔍 PREFLIGHT: Diagnóstico de entorno al arrancar');
console.log('══════════════════════════════════════════════════');

console.log('NODE_VERSION:', process.version);
console.log('CWD:', process.cwd());
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('TZ:', process.env.TZ);
console.log('PORT:', process.env.PORT);
console.log('RAILWAY_SERVICE_NAME:', process.env.RAILWAY_SERVICE_NAME || '(no definida)');
console.log('RAILWAY_ENVIRONMENT_NAME:', process.env.RAILWAY_ENVIRONMENT_NAME || '(no definida)');

// Variables propias del usuario (excluye las del sistema y de Railway)
const systemPattern = /^(RAILWAY_|npm_|YARN_|NODE_VERSION$|PATH$|HOME$|HOSTNAME$|PWD$|SHLVL$|_$|TZ$|DEBIAN_FRONTEND$|NODE_ENV$|PORT$|PUPPETEER_|CHROME_PATH$)/;
const customKeys = Object.keys(process.env).filter(k => !systemPattern.test(k)).sort();
console.log('\n── VARIABLES PROPIAS DETECTADAS (solo nombres) ──');
console.log(customKeys.length ? customKeys.join(', ') : '(ninguna: Railway no está inyectando tus variables)');

const state = (v) => {
  if (v === undefined) return '❌ NO DEFINIDA';
  if (v === '') return '⚠️  VACÍA';
  return `✅ definida (${v.length} caracteres)`;
};

const required = [
  'TELEGRAM_BOT_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'ADMIN_TELEGRAM_ID'
];
const optional = ['GITHUB_BRANCH', 'GITHUB_LOGS_PATH', 'DEBUG'];

console.log('\n── OBLIGATORIAS ──');
for (const k of required) console.log(`${k}: ${state(process.env[k])}`);

console.log('\n── OPCIONALES ──');
for (const k of optional) console.log(`${k}: ${state(process.env[k])}`);

// Chromium
const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || '/usr/bin/chromium';
console.log('\n── CHROMIUM ──');
console.log('Ruta:', chromePath, fs.existsSync(chromePath) ? '✅ existe' : '❌ NO existe');

// Sesión de WhatsApp
console.log('\n── CARPETAS ──');
for (const dir of ['/app/wa_session', '/app/logs']) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    console.log(dir, '✅ escribible');
  } catch (e) {
    console.log(dir, '❌ sin permiso de escritura (si usas Volume, agrega RAILWAY_RUN_UID=0)');
  }
}

// ¿Existe un .env?
const envExists = fs.existsSync('/app/.env') || fs.existsSync('/app/src/.env');
console.log('\n.env en /app o /app/src:', envExists ? '⚠️  SÍ (puede interferir)' : '✅ NO');

const missing = required.filter(k => !process.env[k]);
console.log('\n── RESUMEN ──');
console.log('Obligatorias presentes:', required.length - missing.length, '/', required.length);
console.log('══════════════════════════════════════════════════\n');

if (missing.length) {
  console.error('❌ FALTAN:', missing.join(', '));
  console.error('   Revisa Railway → tu servicio → Variables, y pulsa Deploy en el banner de cambios.');
  process.exit(1);
}
EOF

# Usuario no root
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]

# Ejecuta el preflight y LUEGO el bot
CMD ["sh", "-c", "node /app/preflight.js && exec node src/index.js"]
