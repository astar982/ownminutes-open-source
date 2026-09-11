FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS dependencies

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_VERSION=11.8.0

COPY package.json package-lock.json ./
RUN npm install --global "npm@$NPM_VERSION" \
    && npm config set registry "$NPM_REGISTRY" \
    && npm ci --fetch-retries=5 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=30000 --fetch-timeout=120000

FROM dependencies AS builder

COPY . .
RUN npm run build

FROM dependencies AS production-dependencies

ARG TARGETARCH
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) \
        swc_package="swc-linux-x64-gnu"; \
        sharp_package="sharp-linux-x64"; \
        sharp_libvips_package="sharp-libvips-linux-x64" \
        ;; \
      arm64) \
        swc_package="swc-linux-arm64-gnu"; \
        sharp_package="sharp-linux-arm64"; \
        sharp_libvips_package="sharp-libvips-linux-arm64" \
        ;; \
      *) echo "Unsupported container architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    test -d "node_modules/@next/$swc_package"; \
    test -d "node_modules/sharp"; \
    test -d "node_modules/@img/$sharp_package"; \
    test -d "node_modules/@img/$sharp_libvips_package"; \
    npm prune --omit=dev; \
    for package_dir in node_modules/@next/swc-*; do \
      test -d "$package_dir" || continue; \
      test "${package_dir##*/}" = "$swc_package" || rm -rf -- "$package_dir"; \
    done; \
    for package_dir in node_modules/@img/sharp-*; do \
      test -d "$package_dir" || continue; \
      package_name="${package_dir##*/}"; \
      if test "$package_name" != "$sharp_package" && test "$package_name" != "$sharp_libvips_package"; then \
        rm -rf -- "$package_dir"; \
      fi; \
    done; \
    test "$(node -p "require('sharp').versions.sharp")" = "0.35.4"; \
    test -d "node_modules/@next/$swc_package"; \
    test -d "node_modules/@img/$sharp_package"; \
    test -d "node_modules/@img/$sharp_libvips_package"; \
    npm cache clean --force

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runner

WORKDIR /app
ARG NPM_VERSION=11.8.0
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get -o Acquire::Retries=10 update \
    && apt-get -o Acquire::Retries=10 -o APT::Keep-Downloaded-Packages=true install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=10 -o Acquire::https::Timeout=30 update \
    && for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=10 -o Acquire::https::Timeout=30 -o APT::Keep-Downloaded-Packages=true install -y --no-install-recommends ffmpeg && break; \
      if [ "$attempt" = "5" ]; then exit 1; fi; \
      sleep $((attempt * 3)); \
      apt-get -o Acquire::Retries=10 -o Acquire::https::Timeout=30 update; \
    done \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ARG OWNMINUTES_SOURCE_FINGERPRINT=unverified
LABEL app.ownminutes.source-fingerprint=$OWNMINUTES_SOURCE_FINGERPRINT

COPY --from=production-dependencies /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/db ./db
COPY --from=builder --chown=node:node /app/docs ./docs
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json /app/next.config.ts ./

RUN test "$(npm --version)" = "$NPM_VERSION" \
    && mkdir -p /app/.data/auth /app/.data/audit-archive \
    && chown -R node:node /app/.data

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
