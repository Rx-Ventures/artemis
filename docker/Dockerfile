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
# `--config.node-linker=hoisted` is load-bearing, not tidiness. This repo's
# .npmrc pins `node-linker=isolated`, and a legacy deploy under that linker
# writes the workspace packages (`@rx-artemis/protocol`, `core`, and the SDK)
# into /out/node_modules as **absolute symlinks back into the build tree**
# (/src/packages/*, /src/node_modules/.pnpm/*). Those resolve while /src still
# exists — which is why the deploy ran in every local test — and dangle the
# instant `COPY --from=build /out /app` lands them in a stage where /src is
# gone: the server then dies at its first import with ERR_MODULE_NOT_FOUND for
# `@rx-artemis/protocol`, before it prints a line. (The modern injected deploy
# refuses to run at all under a shared lockfile.) Hoisting the deploy inlines
# every workspace package and dependency as real files, so /out is genuinely
# self-contained — and, as a dividend, it lands the SDK's platform binary at
# top-level `@anthropic-ai/claude-agent-sdk-<platform>/`, which the runtime
# symlink step below then finds without any hand-copying.
RUN pnpm --filter @rx-artemis/server deploy --prod --legacy --config.node-linker=hoisted /out

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out /app

# The Agent SDK's platform package ships the real `claude` binary; put it on
# PATH so signing an account in is `docker exec -it <name> claude auth login`
# with CLAUDE_CONFIG_DIR pointing at the profile's directory under /data.
#
# The hoisted deploy places this binary at top-level
# `@anthropic-ai/claude-agent-sdk-linux-x64/claude`; the search stays broad (and
# fatal on a miss) anyway, because the exact location is the SDK's to change on
# an upgrade, and an image that silently ships with no `claude` on PATH — the
# way this one did while the miss was a shrug rather than a failure — is a
# defect that only surfaces to whoever first tries to sign in. Prefer the glibc
# build this Debian image needs over any musl sibling pnpm may also unpack.
RUN set -eu; \
  bin="$(find /app/node_modules -type f -path '*claude-agent-sdk-linux-x64/claude' 2>/dev/null | head -1)"; \
  if [ -z "$bin" ]; then \
    bin="$(find /app/node_modules -type f -path '*claude-agent-sdk-linux-*/claude' ! -path '*-musl/*' 2>/dev/null | head -1)"; \
  fi; \
  if [ -z "$bin" ]; then \
    echo "No claude binary under /app/node_modules/**/claude-agent-sdk-linux-*/." >&2; \
    echo "The Agent SDK's platform package has moved or was not installed for linux; fix the find above." >&2; \
    exit 1; \
  fi; \
  ln -s "$bin" /usr/local/bin/claude

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
