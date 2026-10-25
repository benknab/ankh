import { Effect } from "effect";
import { Commands } from "#process/commands.ts";
import { BackupError } from "#domain/model.ts";
import { protonEnvironment, protonPaths } from "#clients/proton/state.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

export const login = Effect.fn("Proton.login")(function* () {
  const commands = yield* Commands;
  const { fs } = yield* Storage;
  for (const directory of Object.values(protonPaths)) {
    yield* privateDirectory(directory);
  }
  const options = { env: protonEnvironment };
  const identity = "backup-runner@localhost";
  const keys = yield* commands.run(
    "gpg",
    ["--batch", "--with-colons", "--list-secret-keys"],
    options,
  );
  if (!keys.includes(identity)) {
    yield* commands.run(
      "gpg",
      [
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--quick-generate-key",
        `Backup Runner <${identity}>`,
        "default",
        "default",
        "0",
      ],
      options,
    );
  }
  const listing = yield* commands.run(
    "gpg",
    ["--batch", "--with-colons", "--list-secret-keys", identity],
    options,
  );
  const fingerprint = listing
    .split("\n")
    .find((line) => line.startsWith("fpr:"))
    ?.split(":")[9];
  if (!fingerprint) {
    return yield* new BackupError({
      message: "No GPG fingerprint for Proton credentials",
    });
  }
  // Repair the sign-only key created by the pre-Effect prototype.
  if (
    !listing
      .split("\n")
      .some((line) => line.startsWith("ssb:") && line.split(":")[11]?.includes("e"))
  ) {
    yield* commands.run(
      "gpg",
      [
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--quick-add-key",
        fingerprint,
        "cv25519",
        "encrypt",
        "0",
      ],
      options,
    );
  }
  if (!(yield* fs.exists(`${protonPaths.passwordStore}/.gpg-id`))) {
    yield* commands.run("pass", ["init", fingerprint], options);
  }
  yield* commands.run("proton-drive", ["auth", "login"], {
    ...options,
    interactive: true,
  });
});
