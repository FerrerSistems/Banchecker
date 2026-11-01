FROM node:22-bookworm-slim

# Variables básicas (NO tokens aquí)
ENV NODE_ENV=production \
    TZ=America/Lima \
    DEBIAN_FRONTEND=noninteractive

# Paquetes base
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiamos dependencias primero
COPY package*.json ./

# Instalamos dependencias
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copiamos el resto del código
COPY . .

# Carpetas necesarias y permisos
RUN mkdir -p /app/wa_session /app/tokens /app/logs \
    && chown -R node:node /app

# Script de preflight con diagnóstico completo
COPY --chown=node:node <<'EOF' /app/preflight.js
'use strict';

console.log('══════════════════════════════════════════════════');
console.log('🔍 PREFLIGHT: Diagnóstico de entorno al arrancar');
console.log('══════════════════════════════════════════════════');

console.log('NODE_VERSION:', process.version);
console.log('CWD:', process.cwd());
console.log('__dirname:', __dirname);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('TZ:', process.env.TZ);
console.log('HOSTNAME:', process.env.HOSTNAME);
console.log('PORT:', process.env.PORT);

// Lista TODAS las variables de entorno (nombre)
const allKeys = Object.keys(process.env).sort();
console.log('\n── VARIABLES DE ENTORNO (nombre) ──');
console.log('Total:', allKeys.length);
console.log(JSON.stringify(allKeys, null, 2));

// Valores de las que nos interesan, enmascarados
const keys = [
  'TELEGRAM_BOT_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'GITHUB_BRANCH',
  'GITHUB_LOGS_PATH',
  'ADMIN_TELEGRAM_ID',
  'CHROME_PATH',
  'PUPPETEER_EXECUTABLE_PATH',
  'DEBUG'
];

const mask = (v) => {
  if (v === undefined) return '❌ UNDEFINED';
  if (v === '') return '⚠️  EMPTY';
  if (v.length <= 6) return '✅ ' + '*'.repeat(v.length);
  return '✅ ' + v.slice(0, 3) + '*'.repeat(Math.min(10, v.length - 6)) + v.slice(-3);
};

console.log('\n── VARIABLES CLAVE (valor enmascarado) ──');
for (const k of keys) {
  console.log(`${k} = ${mask(process.env[k])}`);
}

// Resumen de faltantes
const required = [
  'TELEGRAM_BOT_TOKEN',
  'GITHUB_TOKEN',
  'GITHUB_OWNER',
  'GITHUB_REPO',
  'ADMIN_TELEGRAM_ID'
];

const missing = required.filter(k => !process.env[k]);
console.log('\n── RESUMEN ──');
console.log('Obligatorias presentes:', required.length - missing.length, '/', required.length);
if (missing.length) {
  console.log('FALTAN:', JSON.stringify(missing));
}

// ¿Existe un .env?
const fs = require('fs');
const envExists = fs.existsSync('/app/.env') || fs.existsSync('/app/src/.env');
console.log('.env existe en /app o /app/src:', envExists ? '⚠️  SÍ (puede interferir)' : '✅ NO');

console.log('══════════════════════════════════════════════════\n');
EOF

# Usuario no root
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]

# Ejecuta el preflight y LUEGO el bot
CMD ["sh", "-c", "node /app/preflight.js && exec node src/index.js"]
