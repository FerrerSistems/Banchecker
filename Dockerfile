# ══════════════════════════════════════════════════════════════
# BanChecker Bot - Dockerfile (whatsapp-web.js)
# Node 22 + Chromium para whatsapp-web.js
# ══════════════════════════════════════════════════════════════

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=America/Lima \
    DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Dependencias del sistema, incluyendo Chromium y fuentes para el renderizado
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    tini \
    fonts-liberation \
    fonts-noto-color-emoji \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Usuario no-root
RUN groupadd -r botuser && useradd -r -g botuser botuser

WORKDIR /app

# Copiar package.json e instalar dependencias de Node
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copiar el código fuente
COPY --chown=botuser:botuser src/ ./src/
COPY --chown=botuser:botuser logs/ ./logs/

# Verificar que el archivo clave exista
RUN test -f /app/src/config.js && echo "✅ config.js EXISTE" || (echo "❌ config.js NO EXISTE" && exit 1)

# Carpetas para la sesión de WhatsApp
RUN mkdir -p /app/wa_session /app/tokens \
    && chown -R botuser:botuser /app

USER botuser

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
