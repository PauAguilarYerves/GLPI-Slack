FROM node:24-bookworm-slim

# Zona horaria: DEBE coincidir con la del servidor de GLPI. La API devuelve
# fechas sin offset, y si los relojes no cuadran el cursor se desajusta.
ENV TZ=Europe/Madrid
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# La base de datos vive en un volumen; el usuario 'node' debe poder escribirla.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV DB_PATH=/app/data/bridge.sqlite
VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD node src/tools/healthcheck.js

CMD ["node", "src/index.js"]
