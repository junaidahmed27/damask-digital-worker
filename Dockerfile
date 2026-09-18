# The Work Ledger as a container. The same commit that deploys to Vercel runs
# here, which is what makes the customer cloud path a configuration rather than a
# fork: no code is conditional on where it is running.
#
# One dependency tree, installed once and pruned in place after the build, rather
# than a production tree and a development tree side by side. A build that needs
# three copies of node_modules on disk is a build that fails on a small runner.
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# The migration runner as a single file, bundled while the development
# dependencies are still here. The runtime image has no tsx to run the TypeScript
# with, and adding one back to run one script is the wrong trade.
RUN npx esbuild scripts/migrate.ts \
      --bundle --platform=node --format=esm --packages=external \
      --alias:@=. --outfile=migrate.mjs

# The build cache is four hundred megabytes of incremental compilation state that
# the server never reads. It is dropped here rather than filtered on the way out,
# because a COPY cannot exclude a subdirectory.
RUN npm prune --omit=dev && npm cache clean --force && rm -rf .next/cache .next/trace

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

RUN useradd --system --uid 10001 --create-home ledger

# --chown on the COPY rather than a chown afterwards: a RUN chown -R rewrites
# every file it touches into a new layer, which doubles the image.
COPY --from=build --chown=ledger:ledger /app/node_modules ./node_modules
COPY --from=build --chown=ledger:ledger /app/.next ./.next
COPY --from=build --chown=ledger:ledger /app/public ./public
COPY --from=build --chown=ledger:ledger /app/package.json ./package.json
COPY --from=build --chown=ledger:ledger /app/next.config.ts ./next.config.ts
COPY --from=build --chown=ledger:ledger /app/migrate.mjs ./migrate.mjs
COPY --from=build --chown=ledger:ledger /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Everything the runtime reads at run time, not only the compiled application:
# the migrations, the workflow definitions and the fixtures are data the ledger
# loads, and lib/paths.ts resolves them from the working directory.
COPY --from=build --chown=ledger:ledger /app/lib/db/migrations ./lib/db/migrations
COPY --from=build --chown=ledger:ledger /app/workflows ./workflows
COPY --from=build --chown=ledger:ledger /app/fixtures ./fixtures

# The embedded database and the sandbox connectors write under .ledger-data. In
# Azure this is unused, because DATABASE_URL points at Azure Database for
# PostgreSQL and blobs go to Blob Storage, but a container that cannot start
# without a managed database is a container nobody can try.
RUN mkdir -p /app/.ledger-data && chown ledger:ledger /app /app/.ledger-data
VOLUME ["/app/.ledger-data"]

USER ledger

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.ok&&b.queue?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
