# Headless Artemis.
#
# Two stages: a pnpm workspace build (server + the two packages it stands on;
# the desktop app and its Electron download are never pulled in), then a slim
# runtime holding the pruned production tree.
#
# The runtime image doubles as the agent's world — its bash runs *here* — so
# the tools installed below are the tools every served conversation has. Add
# what your work needs (compilers, package managers, gh) by extending this
# image; git and ca-certificates are the floor.

FROM node:22-bookworm-slim AS build
RUN corepack enable pnpm
WORKDIR /src

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY packages/core ./packages/core
COPY apps/server ./apps/server
# The server does not import the SDK, but the workspace *root* declares it as a
# devDependency (`@rx-ventures/artemis-sdk`, the one package the fork never
# renamed). `pnpm install --filter` below is happy without it — filtering walks
# only the server's own subgraph — but `pnpm deploy` resolves the root manifest
# in full and refuses on a `workspace:*` dependency whose package is absent from
# the build context. Copying the manifest is enough to satisfy that resolution;
# nothing in it is built or shipped.
COPY packages/sdk ./packages/sdk

# Filtered to the server and what it depends on: the desktop app is not in
# the graph, so Electron is neither downloaded nor built.
RUN pnpm install --frozen-lockfile --filter @rx-artemis/server...
RUN pnpm --filter @rx-artemis/server build
RUN pnpm --filter @rx-artemis/server deploy --prod --legacy /out

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out /app

# The Agent SDK's platform package ships the real `claude` binary; put it on
# PATH so signing an account in is `docker exec -it <name> claude login`
# with CLAUDE_CONFIG_DIR pointing at the profile's directory under /data.
RUN set -e; \
  bin="$(ls /app/node_modules/@anthropic-ai/claude-agent-sdk-*/claude 2>/dev/null | head -1)"; \
  if [ -n "$bin" ]; then ln -s "$bin" /usr/local/bin/claude; fi

ENV ARTEMIS_DATA_DIR=/data \
    ARTEMIS_BIND_HOST=0.0.0.0 \
    NODE_ENV=production

# /data — profiles, tokens, the session ledger, provider config directories.
# /work — the repositories connections pin as their working directories.
VOLUME ["/data", "/work"]
EXPOSE 6472

ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["serve"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:6472/health || exit 1
