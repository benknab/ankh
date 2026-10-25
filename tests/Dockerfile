FROM backup-runner-toolchain

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY main.ts tsconfig.json vite.config.ts ./
COPY tests ./tests
COPY src ./src
COPY gitea-askpass.sh /app/gitea-askpass.sh
RUN chmod 0755 /app/gitea-askpass.sh

ENTRYPOINT ["pnpm", "test:integration:run"]
