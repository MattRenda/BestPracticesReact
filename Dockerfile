# HireMe: one container serves the web app and the API. Data lives in /data (mount a volume there).
FROM node:22-slim AS build
WORKDIR /app
COPY web/package*.json web/
RUN npm --prefix web ci
COPY web web
RUN npm --prefix web run build

FROM node:22-slim
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/hireme.db PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY server/package*.json server/
# Chromium (and the system libraries it needs) for the agent that applies to jobs for developers
RUN npm --prefix server ci --omit=dev \
  && cd server && npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.cache
COPY server server
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/src/index.js"]
