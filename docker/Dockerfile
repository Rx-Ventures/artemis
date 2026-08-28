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
# PATH so signing an account in is `docker exec -it <name> claude auth login`
# with CLAUDE_CONFIG_DIR pointing at the profile's directory under /data.
#
# The binary is not a direct dependency of anything the server declares — it is
# an *optional* dependency of the SDK, selected by platform — so pnpm keeps it
# where every transitive dependency lives, nested under the SDK's own
# `node_modules` (and, in the store layout, under `.pnpm/`), not flattened to
# the top of `@anthropic-ai/`. A glob rooted one level deep misses it entirely,
# which is how an image shipped for a long time with no `claude` on PATH and a
# green build: the miss was guarded with `if [ -n "$bin" ]`, so the one defect
# — that no account could ever be signed in — surfaced only to whoever first
# tried, at the one moment they could not fix it. So: search the whole tree,
# prefer the glibc build this Debian image needs over any musl sibling pnpm may
# also have unpacked, and make a genuine miss a build failure, not a shrug.
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
