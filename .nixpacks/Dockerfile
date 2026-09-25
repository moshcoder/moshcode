FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067

ENTRYPOINT ["/bin/bash", "-l", "-c"]
WORKDIR /app/
ARG PUBLIC_ORIGIN
ENV PUBLIC_ORIGIN=$PUBLIC_ORIGIN


COPY .nixpacks/nixpkgs-ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7.nix .nixpacks/nixpkgs-ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7.nix
RUN nix-env -if .nixpacks/nixpkgs-ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7.nix && nix-collect-garbage -d


ARG CI NIXPACKS_METADATA NIXPACKS_NODE_VERSION NIXPACKS_START_CMD NODE_ENV NPM_CONFIG_PRODUCTION
ENV CI=$CI NIXPACKS_METADATA=$NIXPACKS_METADATA NIXPACKS_NODE_VERSION=$NIXPACKS_NODE_VERSION NIXPACKS_START_CMD=$NIXPACKS_START_CMD NODE_ENV=$NODE_ENV NPM_CONFIG_PRODUCTION=$NPM_CONFIG_PRODUCTION

# setup phase
# noop

# install phase
ENV NIXPACKS_PATH=/app/node_modules/.bin:$NIXPACKS_PATH
COPY . /app/.
RUN --mount=type=cache,id=fjYY9kqIykc-/root/local/share/pnpm/store/v3,target=/root/.local/share/pnpm/store/v3 npm install -g corepack@0.36.0 && corepack enable
RUN --mount=type=cache,id=fjYY9kqIykc-/root/local/share/pnpm/store/v3,target=/root/.local/share/pnpm/store/v3 pnpm i --frozen-lockfile

# build phase
# noop


RUN printf '\nPATH=/app/node_modules/.bin:$PATH' >> /root/.profile


# start
COPY . /app

CMD ["node apps/pwa/src/server.mjs"]

