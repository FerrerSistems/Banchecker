# ══════════════════════════════════════════════════════════════
# BanChecker Bot - Dockerfile
# Node 22 + supunmd-bail (NO necesita Chromium)
# ══════════════════════════════════════════════════════════════

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=America/Lima \
    DEBIAN_FRONTEND=noninteractive

# Solo las dependencias mínimas del sistema
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Usuario no-root
RUN groupadd -r botuser && useradd -r -g botuser botuser

WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copiar código fuente
COPY --chown=botuser:botuser src/ ./src/
COPY --chown=botuser:botuser logs/ ./logs/

# Diagnóstico: ver qué se copió
RUN echo "===== /app/src =====" && ls -la /app/src
RUN test -f /app/src/config.js && echo "✅ config.js EXISTE" || (echo "❌ config.js NO EXISTE" && exit 1)

# Carpetas de sesión
RUN mkdir -p /app/wa_session /app/tokens \
    && chown -R botuser:botuser /app

USER botuser

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
