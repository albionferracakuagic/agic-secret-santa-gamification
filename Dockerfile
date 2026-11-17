# Server image (built remotely with `az acr build` by the deploy workflow). Not built locally in CI yet.
FROM node:24-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w apps/web && npx tsc -b

FROM node:24-alpine
ENV NODE_ENV=production
ENV WEB_DIST=/app/apps/web/dist
WORKDIR /app
COPY --from=build /app .
RUN npm prune --omit=dev
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
