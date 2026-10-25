import { Array, Effect, Option } from "effect";
import { BackupError, backupError } from "#domain/model.ts";
import { runProton } from "#clients/proton/command.ts";
import { checkKey, ensureKey, requireKey } from "#clients/proton/keys.ts";
import { keyProtection, ProtonState } from "#clients/proton/state.ts";
import { Storage } from "#storage/storage.ts";

const probe = "ankh-probe";

const recipients = Effect.fn("Proton.recipients")(
  function* () {
    const { fs, path } = yield* Storage;
    const { passwordStore } = yield* ProtonState;
    const file = path.join(passwordStore, ".gpg-id");
    if (!(yield* fs.exists(file))) {
      return Option.none<readonly string[]>();
    }
    const text = yield* fs.readFileString(file);
    return Option.some(
      Array.filter(
        Array.map(text.split("\n"), (line) => line.trim()),
        (line) => line !== "",
      ),
    );
  },
  Effect.mapError(backupError("Proton password store")),
);

const checkRecipients = Effect.fn("Proton.checkRecipients")(function* (
  fingerprint: string,
  current: readonly string[],
) {
  const { passwordStore, gnupg } = yield* ProtonState;
  if (current.length !== 1 || current[0] !== fingerprint) {
    return yield* BackupError.make({
      message: `${passwordStore} is encrypted for a different key than ${gnupg}; restore the matching key, or remove ${passwordStore} and run proton-login`,
    });
  }
});

const ensureStore = Effect.fn("Proton.ensureStore")(function* (fingerprint: string) {
  const current = yield* recipients();
  if (Option.isNone(current)) {
    yield* runProton("pass", ["init", fingerprint]);
    return;
  }
  yield* checkRecipients(fingerprint, current.value);
});

// Prove that pass can encrypt and decrypt before the browser login creates a remote session.
const probeStore = Effect.fn("Proton.probeStore")(function* () {
  yield* runProton("pass", ["insert", "--force", "--multiline", probe]);
  yield* runProton("pass", ["show", probe]);
  yield* runProton("pass", ["rm", "--force", probe]);
});

export const setupCredentials = Effect.fn("Proton.setupCredentials")(function* () {
  const fingerprint = yield* ensureKey(yield* keyProtection());
  yield* ensureStore(fingerprint);
  yield* probeStore();
});

export const verifyCredentials = Effect.fn("Proton.verifyCredentials")(function* () {
  const key = yield* requireKey();
  yield* checkKey(key, yield* keyProtection());
  const current = yield* recipients();
  if (Option.isNone(current)) {
    return yield* BackupError.make({
      message: "Proton credentials are not set up; run proton-login",
    });
  }
  yield* checkRecipients(key.fingerprint, current.value);
});
