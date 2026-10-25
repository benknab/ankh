FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS base

USER root

ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 || (echo "ankh supports linux/amd64 only" >&2; exit 1)

ARG PROTON_DRIVE_VERSION=0.8.0
ARG PROTON_DRIVE_SHA512=a730f9e420fef69244acb9b12aa8e0c03b8216f5d94ff2181cf3df2859a143fc2693fe201c3a00fddaff5d702c34435af72a5283dbbe1da9e038d77a107e24f3

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
    ca-certificates \
    git \
    git-lfs \
    gnupg \
    pass \
    restic \
    sqlite3 \
    tar \
    util-linux \
    wget \
    zstd \
    && wget --quiet \
      --output-document=/tmp/proton-drive \
      "https://proton.me/download/drive/cli/${PROTON_DRIVE_VERSION}/linux-x64-baseline/proton-drive" \
    && printf '%s  %s\n' "${PROTON_DRIVE_SHA512}" /tmp/proton-drive | sha512sum --check \
    && install -o root -g root -m 0755 /tmp/proton-drive /usr/local/bin/proton-drive \
    && rm /tmp/proton-drive \
    && rm -rf /var/lib/apt/lists/*

RUN wget --quiet --output-document=/usr/share/keyrings/postgresql.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && mkdir -m 0700 /tmp/pg-key-check \
    && gpg --homedir /tmp/pg-key-check --batch --with-colons --show-keys /usr/share/keyrings/postgresql.asc > /tmp/pg-keys \
    && test "$(awk -F: '$1 == "pub" { primary = 1; next } primary && $1 == "fpr" { print $10; primary = 0 }' /tmp/pg-keys)" = B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 \
    && rm -rf /tmp/pg-key-check /tmp/pg-keys \
    && . /etc/os-release \
    && printf 'deb [signed-by=/usr/share/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$VERSION_CODENAME" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install --yes --no-install-recommends postgresql-client-15 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY LICENSE THIRD_PARTY_NOTICES.md /usr/local/share/doc/ankh/
LABEL org.opencontainers.image.source="https://github.com/benknab/ankh" \
      org.opencontainers.image.licenses="MIT"

FROM base AS dependencies
RUN npm install --global pnpm@12.15.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS runner
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
RUN find src -type f -name '*.test.ts' -delete && rm -rf src/testing
COPY gitea-askpass.sh /app/gitea-askpass.sh
RUN chmod 0755 /app/gitea-askpass.sh

ENTRYPOINT ["node", "/app/src/main.ts"]
