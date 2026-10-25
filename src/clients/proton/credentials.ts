import { Array, Effect, Option, Schema } from "effect";
import { Commands } from "#process/commands.ts";
import { backupError } from "#domain/model.ts";
import { protonEnvironment } from "#clients/proton/state.ts";

const identity = "backup-runner@localhost";
const options = { env: protonEnvironment };
const Fingerprint = Schema.String.check(Schema.isPattern(/^[A-F0-9]{40,64}$/u));

const ensureIdentity = Effect.fn("Proton.ensureIdentity")(function* () {
  const commands = yield* Commands;
  const keys = yield* commands.run(
    "gpg",
    ["--batch", "--with-colons", "--list-secret-keys"],
    options,
  );
  if (!keys.stdout.includes(identity)) {
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
});

const readKey = Effect.fn("Proton.readKey")(
  function* () {
    const commands = yield* Commands;
    const listing = yield* commands.run(
      "gpg",
      ["--batch", "--with-colons", "--list-secret-keys", identity],
      options,
    );
    const lines = listing.stdout.split("\n");
    const row = Option.getOrUndefined(Array.findFirst(lines, (line) => line.startsWith("fpr:")));
    const fingerprint = yield* Schema.decodeUnknownEffect(Fingerprint)(row?.split(":")[9]);
    const encrypts = Array.some(
      lines,
      (line) => line.startsWith("ssb:") && line.split(":")[11]?.includes("e") === true,
    );
    return { fingerprint, encrypts };
  },
  Effect.mapError(backupError("Proton credential key")),
);

export const ensureKey = Effect.fn("Proton.ensureKey")(function* () {
  const commands = yield* Commands;
  yield* ensureIdentity();
  const key = yield* readKey();
  // Repair sign-only keys from the original prototype.
  if (!key.encrypts) {
    yield* commands.run(
      "gpg",
      [
        "--batch",
        "--pinentry-mode",
        "loopback",
        "--passphrase",
        "",
        "--quick-add-key",
        key.fingerprint,
        "cv25519",
        "encrypt",
        "0",
      ],
      options,
    );
  }
  return key.fingerprint;
});
