FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
# O .env da raiz e versionado para o ambiente de desenvolvimento e precisa
# estar nesta imagem para o carregador da API e as migrations encontrarem-no.
COPY .env ./.env
RUN npm run build

# Imagem de uso unico para aplicar migrations durante o deploy. Mantem as
# dependencias de desenvolvimento fora da imagem que atende requisicoes.
FROM build AS migrate

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3333

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/.env ./.env

RUN mkdir -p /app/uploads && chown -R node:node /app
USER node

EXPOSE 3333
# /healthz e liveness puro: nao consulta o Neon. Com /health aqui, uma queda do
# banco marcaria o container como unhealthy e o orquestrador o reiniciaria em
# loop — reiniciar a API nao conserta banco fora do ar.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3333/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/index.js"]
