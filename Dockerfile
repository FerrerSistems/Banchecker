FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    TZ=America/Lima \
    DEBIAN_FRONTEND=noninteractive

# 1. Instalamos git (vital para Baileys) y tini (para cerrar procesos correctamente)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Copiamos los archivos de dependencias
COPY package*.json ./

# 3. Instalación limpia (borramos lockfile viejo para evitar conflictos)
RUN rm -rf node_modules package-lock.json \
    && npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# 4. Copiamos el resto del código fuente
COPY . .

# 5. Creamos las carpetas y le damos permisos al usuario "node" de TODO /app
RUN mkdir -p /app/wa_session \
    && chown -R node:node /app

# 6. Cambiamos al usuario no-root
USER node

# 7. Usamos tini como entrypoint para manejar señales de Docker
ENTRYPOINT ["/usr/bin/tini", "--"]

# 8. Comando de inicio
CMD ["node", "src/index.js"]
