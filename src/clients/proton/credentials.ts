import { Array, Effect, Option } from "effect";
import { BackupError, backupError } from "#domain/model.ts";
import { runProton } from "#clients/proton/command.ts";
import { checkKey, ensureKey, requireKey } from "#clients/proton/keys.ts";
import { type KeyProtection, keyProtection, ProtonState } from "#clients/proton/state.ts";
import { Storage } from "#storage/storage.ts";

// The CLI stores its session in this folder, and pass encrypts each entry to the nearest .gpg-id.
const sessionFolders = ["ch.proton.drive", "ch.proton.drive/drive-sdk-cli"] as const;
const probe = "ch.proton.drive/drive-sdk-cli/ankh-probe";

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
  const { fs, path } = yield* Storage;
  const { passwordStore, gnupg } = yield* ProtonState;
  if (current.length !== 1 || current[0] !== fingerprint) {
    return yield* BackupError.make({
      message: `${passwordStore} is encrypted for a different key than ${gnupg}; restore the matching key, or remove ${passwordStore} and run proton-login`,
    });
  }
  const [override] = yield* Effect.filter(sessionFolders, (folder) =>
    fs.exists(path.join(passwordStore, folder, ".gpg-id")),
  ).pipe(Effect.mapError(backupError("Proton password store")));
  if (override !== undefined) {
    return yield* BackupError.make({
      message: `${path.join(passwordStore, override, ".gpg-id")} overrides the Proton key; remove it and run proton-login`,
    });
  }
});

const ensureStore = Effect.fn("Proton.ensureStore")(function* (fingerprint: string) {
  const current = yield* recipients();
  if (Option.isNone(current)) {
    // Check nested recipients before pass init can re-encrypt any existing entries.
    yield* checkRecipients(fingerprint, [fingerprint]);
    yield* runProton("pass", ["init", fingerprint]);
  }
  yield* checkRecipients(
    fingerprint,
    Option.getOrElse(current, () => [fingerprint]),
  );
});

// Prove that pass can encrypt and decrypt before the browser login creates a remote session.
const probeStore = Effect.fn("Proton.probeStore")(function* (protection: KeyProtection) {
  const { gnupg, passwordStore } = yield* ProtonState;
  yield* runProton("pass", ["insert", "--force", "--multiline", probe]);
  yield* runProton("pass", ["show", probe]).pipe(
    Effect.mapError((error) =>
      protection._tag === "Passphrase"
        ? BackupError.make({
            message: `The Proton GPG key cannot be unlocked with ${protection.file}; to change the passphrase, remove ${gnupg} and ${passwordStore} and run proton-login`,
            operation: "pass",
          })
        : error,
    ),
    Effect.ensuring(runProton("pass", ["rm", "--force", probe]).pipe(Effect.ignore)),
  );
});

// Ankh passes the passphrase file on every call. A cached passphrase would let anything that
// reaches the agent socket in the shared volume decrypt the session without that file.
const agentConfig = "default-cache-ttl 0\nmax-cache-ttl 0\n";

const ensureAgentConfig = Effect.fn("Proton.ensureAgentConfig")(function* () {
  const { fs, path } = yield* Storage;
  const { gnupg } = yield* ProtonState;
  const file = path.join(gnupg, "gpg-agent.conf");
  const current = yield* fs.exists(file).pipe(
    Effect.flatMap((exists) => (exists ? fs.readFileString(file) : Effect.succeed(""))),
    Effect.mapError(backupError("Proton agent configuration")),
  );
  if (current === agentConfig) {
    return;
  }
  yield* fs
    .writeFileString(file, agentConfig, { mode: 0o600 })
    .pipe(Effect.mapError(backupError("Proton agent configuration")));
  // A running agent keeps its old settings until it reloads them.
  yield* runProton("gpg-connect-agent", ["RELOADAGENT", "/bye"]);
});

export const setupCredentials = Effect.fn("Proton.setupCredentials")(function* () {
  yield* ensureAgentConfig();
  const protection = yield* keyProtection();
  const fingerprint = yield* ensureKey(protection);
  yield* ensureStore(fingerprint);
  yield* probeStore(protection);
});

export const verifyCredentials = Effect.fn("Proton.verifyCredentials")(function* () {
  const key = yield* requireKey();
  yield* ensureAgentConfig();
  yield* checkKey(key, yield* keyProtection());
  const current = yield* recipients();
  if (Option.isNone(current)) {
    return yield* BackupError.make({
      message: "Proton credentials are not set up; run proton-login",
    });
  }
  yield* checkRecipients(key.fingerprint, current.value);
});
