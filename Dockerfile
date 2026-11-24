# JournL MCP server image (Node 22, non-root).
# Configuration comes from environment variables (see .env.example); no .env file is baked in.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3100 \
    CLIENTS_FILE=/app/data/clients.json

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY assets ./assets

# Registered OAuth clients persist here: mount persistent storage at /app/data.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
