# HitReg dedicated servers — one image, three roles (main / layer / instance).
#
#   docker build -f deploy/Dockerfile -t hitreg-server .
#   docker run --rm -p 8780:8780 -p 8801-8810:8801-8810 \
#     -e HITREG_SECRET=change-me -e PUBLIC_HOST=your.host.name \
#     -v hitreg-data:/data hitreg-server
#
# The image carries the engine and the playground's `projects/` (your game
# content — gitignored in the engine repo, so it is copied from the build
# context, i.e. the checkout you build from). Rebuild to ship a content
# version; `docs/hosting.md` → "Rolling a content version" for the zero-
# downtime sequence.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# dependencies first, for layer caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/net/package.json packages/net/
COPY packages/physics/package.json packages/physics/
COPY packages/scripting/package.json packages/scripting/
COPY packages/render/package.json packages/render/
COPY packages/comms/package.json packages/comms/
COPY packages/editor/package.json packages/editor/
COPY packages/server/package.json packages/server/
COPY apps/playground/package.json apps/playground/
RUN pnpm install --frozen-lockfile --prod=false

# sources run under tsx — no build step, same as `pnpm -F @hitreg/server serve`
COPY packages ./packages
COPY apps/playground/projects ./apps/playground/projects
COPY apps/playground/assets ./apps/playground/assets
COPY apps/playground/tools ./apps/playground/tools
COPY tools ./tools

ENV NODE_ENV=production
ENV HITREG_DATA=/data
VOLUME ["/data"]
EXPOSE 8780 8801-8899

# default role: main with its supervisor starting layers in this container.
# Override the command for an externally-started layer:
#   node --import tsx packages/server/bin/serve.ts --scene mmo --main ws://main:8780 --secret … --id layer-1 --kind layer --public-url ws://host:8801 --port 8801 --host 0.0.0.0
ENTRYPOINT ["/bin/sh", "-c"]
CMD ["exec node --import tsx packages/server/bin/main.ts --scene ${SCENE:-mmo} --secret ${HITREG_SECRET} --public-host ${PUBLIC_HOST:-127.0.0.1} --public-scheme ${PUBLIC_SCHEME:-ws} --ports ${LAYER_PORTS:-8801-8810} --data /data --cap ${CAP:-40} --min ${MIN_LAYERS:-1} --max ${MAX_LAYERS:-4} ${HITREG_DATABASE_URL:+--database $HITREG_DATABASE_URL} ${MAIN_ARGS:-}"]
