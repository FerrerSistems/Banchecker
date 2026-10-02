# ══════════════════════════════════════════════════════════════
# BanChecker Bot - Dockerfile
# Node 22 + Chromium (Debian Bookworm)
# ══════════════════════════════════════════════════════════════

FROM node:22-bookworm-slim

# ARG para invalidar caché cuando sea necesario
ARG CACHEBUST=2026-10-02

ENV NODE_ENV=production \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    DEBIAN_FRONTEND=noninteractive \
    TZ=America/Lima

# Chromium + dependencias mínimas
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

# Usuario no-root
RUN groupadd -r botuser && useradd -r -g botuser -G audio,video botuser \
    && mkdir -p /home/botuser/Downloads \
    && chown -R botuser:botuser /home/botuser

WORKDIR /app

# Dependencias primero (mejor caching de npm)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copia explícita del código (evita problemas con .dockerignore)
COPY --chown=botuser:botuser src/ ./src/
COPY --chown=botuser:botuser logs/ ./logs/

# ─── DIAGNÓSTICO: ver qué se copió ───
RUN echo "===== /app =====" && ls -la /app
RUN echo "===== /app/src =====" && ls -la /app/src
RUN echo "===== /app/logs =====" && ls -la /app/logs
RUN test -f /app/src/config.js && echo "✅ config.js EXISTE" || (echo "❌ config.js NO EXISTE" && exit 1)

# Carpetas de sesión
RUN mkdir -p /app/wa_session /app/tokens \
    && chown -R botuser:botuser /app

USER botuser

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
