FROM node:22-bookworm-slim

# Variables básicas de entorno (NO pongas tokens aquí)
ENV NODE_ENV=production \
    TZ=America/Lima \
    DEBIAN_FRONTEND=noninteractive

# Instalamos git (necesario para Baileys), tini (para manejar procesos) y certificados
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiamos solo los archivos de dependencias primero (para aprovechar la caché de Docker)
COPY package*.json ./

# Instalamos las dependencias
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Copiamos el resto del código
COPY . .

# Creamos las carpetas necesarias y le damos permisos al usuario "node"
RUN mkdir -p /app/wa_session /app/tokens \
    && chown -R node:node /app

# Usamos el usuario "node" (no root) por seguridad
USER node

# Tini maneja las señales de terminación correctamente
ENTRYPOINT ["/usr/bin/tini", "--"]

# Comando para iniciar el bot
CMD ["node", "src/index.js"]
