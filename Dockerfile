# ══════════════════════════════════════════════════════════════
# DOCKERFILE - BanChecker Bot
# Node.js + Chromium + Puppeteer para WhatsApp Web
# Optimizado para Railway
# ══════════════════════════════════════════════════════════════

# ── ETAPA 1: Base con Node.js 18 ─────────────────────────────
FROM node:18-bullseye-slim AS base

# Variables de entorno
ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DEBIAN_FRONTEND=noninteractive \
    TZ=America/Lima

# ── ETAPA 2: Instalar dependencias del sistema ───────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium
    chromium \
    chromium-driver \
    # Fuentes (necesarias para que Chromium renderice bien)
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    # Librerías requeridas por Chromium
    ca-certificates \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    # Utilidades
    curl \
    git \
    tini \
    # Limpiar caché
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ── ETAPA 3: Crear usuario no-root ───────────────────────────
# Chromium no debe correr como root
RUN groupadd -r botuser && useradd -r -g botuser -G audio,video botuser \
    && mkdir -p /home/botuser/Downloads \
    && chown -R botuser:botuser /home/botuser

# ── ETAPA 4: Directorio de trabajo ───────────────────────────
WORKDIR /app

# Copiar package.json primero (mejor caching de Docker)
COPY package*.json ./

# ── ETAPA 5: Instalar dependencias de Node ───────────────────
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# ── ETAPA 6: Copiar código fuente ────────────────────────────
COPY --chown=botuser:botuser . .

# ── ETAPA 7: Crear carpetas necesarias con permisos ──────────
RUN mkdir -p /app/wa_session /app/logs /app/tokens \
    && chown -R botuser:botuser /app

# ── ETAPA 8: Cambiar a usuario no-root ───────────────────────
USER botuser

# ── ETAPA 9: Variables de entorno finales ────────────────────
ENV CHROME_PATH=/usr/bin/chromium \
    PORT=3000

# ── ETAPA 10: Healthcheck (opcional) ─────────────────────────
# Comenta si no quieres healthcheck
# HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
#   CMD pgrep -f "node" || exit 1

# ── ETAPA 11: Exponer puerto (Railway lo usa si hay web server) ──
EXPOSE 3000

# ── ETAPA 12: Entrypoint con tini (maneja señales correctamente) ──
ENTRYPOINT ["/usr/bin/tini", "--"]

# ── ETAPA 13: Comando de inicio ──────────────────────────────
CMD ["node", "src/index.js"]
