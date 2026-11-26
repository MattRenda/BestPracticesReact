# HireMe: one container serves the web app and the API. Data lives in /data (mount a volume there).
FROM node:22-slim AS build
WORKDIR /app
COPY web/package*.json web/
RUN npm --prefix web ci
COPY web web
RUN npm --prefix web run build

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/hireme.db
WORKDIR /app
COPY server/package*.json server/
RUN npm --prefix server ci --omit=dev
COPY server server
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
