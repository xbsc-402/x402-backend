# syntax=docker/dockerfile:1.7
FROM node:24-bookworm AS build

ENV PNPM_HOME=/pnpm \
    PNPM_STORE_PATH=/pnpm/store \
    PATH="/pnpm:$PATH" \
    NODE_OPTIONS="--max-old-space-size=8192"
RUN corepack enable

WORKDIR /repo
COPY . .

RUN pnpm install
RUN pnpm --filter x402 build
RUN pnpm --filter x402-launchpad-backend build
RUN pnpm deploy --filter x402-launchpad-backend --prod --legacy /opt/app

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /srv/app
COPY --from=build /opt/app ./
EXPOSE 3001
CMD ["node", "dist/server.js"]
