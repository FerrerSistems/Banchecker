FROM node:22-bookworm-slim

ENV NODE_ENV=production TZ=America/Lima

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY . .

RUN mkdir -p /app/wa_session && chown -R node:node /app

USER node

CMD ["node", "src/index.js"]
