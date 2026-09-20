FROM denoland/deno:2.6.1

USER root

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
    && . /etc/os-release \
    && printf 'deb [signed-by=/usr/share/keyrings/postgresql.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$VERSION_CODENAME" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install --yes --no-install-recommends postgresql-client-15 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install --frozen
COPY main.ts ./
COPY src ./src
RUN deno cache main.ts

ENTRYPOINT ["deno", "run", "--allow-all", "/app/main.ts"]
