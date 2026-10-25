import { Context, Duration } from "effect";
import { type AbsolutePath, absolutePath } from "#domain/model.ts";

export interface ProtonPaths {
  readonly gnupg: AbsolutePath;
  readonly passwordStore: AbsolutePath;
  readonly cache: AbsolutePath;
  readonly lock: AbsolutePath;
  readonly lockTimeout: Duration.Duration;
}

export const ProtonState = Context.Reference<ProtonPaths>("ankh/clients/proton/state/ProtonState", {
  defaultValue: () => ({
    gnupg: absolutePath("/proton/gnupg"),
    passwordStore: absolutePath("/proton/pass"),
    cache: absolutePath("/proton/cache"),
    lock: absolutePath("/proton/lock"),
    lockTimeout: Duration.hours(6),
  }),
});

export const protonEnvironment = (paths: ProtonPaths): Readonly<Record<string, string>> => ({
  GNUPGHOME: paths.gnupg,
  HOME: "/tmp",
  PASSWORD_STORE_DIR: paths.passwordStore,
  PROTON_DRIVE_CACHE_DIR: paths.cache,
  PROTON_DRIVE_CREDENTIALS_STORE: "pass",
  PROTON_DRIVE_LOG_LEVEL: "WARNING",
});
