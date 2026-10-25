import { Array, Effect, Option, Redacted, Schema } from "effect";
import { backupError } from "#domain/model.ts";
import { runProton } from "#clients/proton/command.ts";

// Keep the stored key identity stable across the Ankh rename.
const identity = "backup-runner@localhost";
const Fingerprint = Schema.String.check(Schema.isPattern(/^[A-F0-9]{40,64}$/u));

const ensureIdentity = Effect.fn("Proton.ensureIdentity")(function* () {
  const keys = yield* runProton("gpg", ["--batch", "--with-colons", "--list-secret-keys"]);
  if (!Redacted.value(keys.stdout).includes(identity)) {
    yield* runProton("gpg", [
      "--batch",
      "--pinentry-mode",
      "loopback",
      "--passphrase",
      "",
      "--quick-generate-key",
      `Ankh <${identity}>`,
      "default",
      "default",
      "0",
    ]);
  }
});

const readKey = Effect.fn("Proton.readKey")(
  function* () {
    const listing = yield* runProton("gpg", [
      "--batch",
      "--with-colons",
      "--list-secret-keys",
      identity,
    ]);
    const lines = Redacted.value(listing.stdout).split("\n");
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
  yield* ensureIdentity();
  const key = yield* readKey();
  // Repair sign-only keys from the original prototype.
  if (!key.encrypts) {
    yield* runProton("gpg", [
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
    ]);
  }
  return key.fingerprint;
});
