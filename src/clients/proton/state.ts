import { Context, Duration, Effect, Schema } from "effect";
import {
  type AbsolutePath,
  absolutePath,
  BackupError,
  backupError,
  protonPassphraseFile,
} from "#domain/model.ts";
import { Storage } from "#storage/storage.ts";

export interface ProtonPaths {
  readonly gnupg: AbsolutePath;
  readonly passwordStore: AbsolutePath;
  readonly cache: AbsolutePath;
  readonly lock: AbsolutePath;
  // Interpolated into PASSWORD_STORE_GPG_OPTS, which pass splits on whitespace.
  readonly passphraseFile: AbsolutePath;
  readonly lockTimeout: Duration.Duration;
}

export const ProtonState = Context.Reference<ProtonPaths>("ankh/clients/proton/state/ProtonState", {
  defaultValue: () => ({
    gnupg: absolutePath("/proton/gnupg"),
    passwordStore: absolutePath("/proton/pass"),
    cache: absolutePath("/proton/cache"),
    lock: absolutePath("/proton/lock"),
    passphraseFile: protonPassphraseFile,
    lockTimeout: Duration.hours(6),
  }),
});

export type KeyProtection =
  | { readonly _tag: "None" }
  | { readonly _tag: "Passphrase"; readonly file: AbsolutePath };

const PassphraseText = Schema.String.check(Schema.isPattern(/^[^\r\n\0]+\n?$/u));

export const keyProtection = Effect.fn("Proton.keyProtection")(function* (): Effect.fn.Return<
  KeyProtection,
  BackupError,
  Storage
> {
  const { fs } = yield* Storage;
  const { passphraseFile } = yield* ProtonState;
  if (!(yield* fs.exists(passphraseFile).pipe(Effect.mapError(backupError("Proton passphrase"))))) {
    return { _tag: "None" };
  }
  // GnuPG reads only the first line, so reject files it would silently truncate or leave empty.
  yield* fs.readFileString(passphraseFile).pipe(
    Effect.flatMap(Schema.decodeEffect(PassphraseText)),
    Effect.mapError(() =>
      BackupError.make({
        message: `${passphraseFile} must contain exactly one non-empty line`,
        operation: "Proton passphrase",
      }),
    ),
  );
  return { _tag: "Passphrase", file: passphraseFile };
});

export const passphraseArguments = (protection: KeyProtection): readonly string[] =>
  protection._tag === "Passphrase"
    ? ["--pinentry-mode", "loopback", "--passphrase-file", protection.file]
    : ["--pinentry-mode", "loopback", "--passphrase", ""];

export const protonEnvironment = (
  paths: ProtonPaths,
  protection: KeyProtection,
): Readonly<Record<string, string>> => ({
  GNUPGHOME: paths.gnupg,
  HOME: "/tmp",
  PASSWORD_STORE_DIR: paths.passwordStore,
  PASSWORD_STORE_ENABLE_EXTENSIONS: "false",
  PASSWORD_STORE_GPG_OPTS:
    protection._tag === "Passphrase"
      ? `--pinentry-mode loopback --passphrase-file ${protection.file}`
      : "",
  PASSWORD_STORE_KEY: "",
  PASSWORD_STORE_SIGNING_KEY: "",
  PASSWORD_STORE_UMASK: "077",
  PROTON_DRIVE_BASE_URL: "drive-api.proton.me",
  PROTON_DRIVE_CACHE_DIR: paths.cache,
  PROTON_DRIVE_CREDENTIALS_STORE: "pass",
  PROTON_DRIVE_LOG_LEVEL: "WARNING",
  PROTON_DRIVE_UNSAFE_CACHE: "false",
});
