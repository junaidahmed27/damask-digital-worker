# The Work Ledger as a container. The same commit that deploys to Vercel runs
# here, which is what makes the customer cloud path a configuration rather than a
# fork: no code is conditional on where it is running.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && cp -R node_modules /tmp/production_modules
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Everything the runtime reads at run time, not only the compiled application:
# the migrations, the workflow definitions and the fixtures are data the ledger
# loads, and lib/paths.ts resolves them from the working directory.
COPY --from=deps /tmp/production_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/lib/db/migrations ./lib/db/migrations
COPY --from=build /app/workflows ./workflows
COPY --from=build /app/fixtures ./fixtures

RUN useradd --system --uid 10001 ledger && chown -R ledger:ledger /app
USER ledger

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "run", "start"]
