# ══════════════════════════════════════════════════════════════
# DOCKERFILE - BanChecker Bot
# Node.js 22 + Chromium (Debian Bookworm) para WhatsApp Web
# Optimizado para Railway
# ══════════════════════════════════════════════════════════════

FROM node:22-bookworm-slim

# Variables de entorno
ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DEBIAN_FRONTEND=noninteractive \
    TZ=America/Lima

# Instalar Chromium y dependencias mínimas
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    curl \
    git \
    tini \
    fonts-liberation \
    fonts-noto-color-emoji \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Crear usuario no-root
RUN groupadd -r botuser && useradd -r -g botuser -G audio,video botuser \
    && mkdir -p /home/botuser/Downloads \
    && chown -R botuser:botuser /home/botuser

WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copiar código fuente
COPY --chown=botuser:botuser . .

# Crear carpetas necesarias
RUN mkdir -p /app/wa_session /app/logs /app/tokens \
    && chown -R botuser:botuser /app

USER botuser

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
