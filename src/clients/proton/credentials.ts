import { Array, Effect, Option, Redacted, Schema } from "effect";
import { BackupError, backupError } from "#domain/model.ts";
import { runProton } from "#clients/proton/command.ts";
import {
  type KeyProtection,
  keyProtection,
  passphraseArguments,
  ProtonState,
} from "#clients/proton/state.ts";
import { Storage } from "#storage/storage.ts";

// Keep the stored key identity stable across the Ankh rename.
const identity = "backup-runner@localhost";
const probe = "ankh-probe";

const SecretKey = Schema.Struct({
  fingerprint: Schema.String.check(Schema.isPattern(/^[A-F0-9]{40,64}$/u)),
  keygrips: Schema.NonEmptyArray(Schema.String.check(Schema.isPattern(/^[A-F0-9]{40}$/u))),
  uids: Schema.Array(Schema.String),
  encrypts: Schema.Boolean,
});
export type SecretKey = typeof SecretKey.Type;

interface Draft {
  readonly fingerprint?: string;
  readonly keygrips: readonly string[];
  readonly uids: readonly string[];
  readonly encrypts: boolean;
}

const field = (fields: readonly string[], index: number): string => fields[index] ?? "";

const parseLine = (keys: readonly Draft[], line: string): readonly Draft[] => {
  const fields = line.split(":");
  if (fields[0] === "sec") {
    // Uppercase capabilities on the primary record describe the usable key as a whole.
    return [...keys, { keygrips: [], uids: [], encrypts: field(fields, 11).includes("E") }];
  }
  const current = Array.last(keys);
  if (Option.isNone(current)) {
    return keys;
  }
  const key = current.value;
  const value = field(fields, 9);
  const updated =
    fields[0] === "fpr" && key.fingerprint === undefined
      ? { ...key, fingerprint: value }
      : fields[0] === "grp"
        ? { ...key, keygrips: [...key.keygrips, value] }
        : fields[0] === "uid"
          ? { ...key, uids: [...key.uids, value] }
          : key;
  return [...Array.dropRight(keys, 1), updated];
};

export const parseSecretKeys = Effect.fn("Proton.parseSecretKeys")(
  function* (listing: string) {
    const drafts = Array.reduce(listing.split("\n"), [] as readonly Draft[], parseLine);
    const keys = yield* Schema.decodeUnknownEffect(Schema.Array(SecretKey))(drafts);
    return Array.filter(keys, (key) =>
      Array.some(key.uids, (uid) => uid.includes(`<${identity}>`)),
    );
  },
  Effect.mapError(backupError("Proton key listing")),
);

const findKey = Effect.fn("Proton.findKey")(function* () {
  const listing = yield* runProton("gpg", [
    "--batch",
    "--with-colons",
    "--with-keygrip",
    "--list-secret-keys",
  ]);
  const keys = yield* parseSecretKeys(Redacted.value(listing.stdout));
  if (keys.length > 1) {
    return yield* BackupError.make({
      message: `Multiple GPG keys for ${identity}; keep exactly one in the Proton key store`,
    });
  }
  return Array.head(keys);
});

const requireKey = Effect.fn("Proton.requireKey")(function* () {
  return yield* Option.match(yield* findKey(), {
    onNone: () =>
      BackupError.make({ message: "Proton credentials are not set up; run proton-login" }),
    onSome: Effect.succeed,
  });
});

export const parseProtection = Effect.fn("Proton.parseProtection")(function* (
  key: SecretKey,
  output: string,
) {
  // Agent rows are `S KEYINFO <keygrip> <type> <serial> <id> <cached> <protection> ...`.
  const states = Array.flatMap(output.split("\n"), (line) => {
    const tokens = line.trim().split(/\s+/u);
    return tokens[0] === "S" &&
      tokens[1] === "KEYINFO" &&
      Array.some(key.keygrips, (grip) => grip === tokens[2])
      ? [field(tokens, 7)]
      : [];
  });
  if (states.length !== key.keygrips.length) {
    return yield* BackupError.make({ message: "GPG agent did not report every Proton key part" });
  }
  return Array.every(states, (state) => state === "P")
    ? ("protected" as const)
    : Array.every(states, (state) => state === "C")
      ? ("unprotected" as const)
      : ("mixed" as const);
});

const readProtection = Effect.fn("Proton.readProtection")(function* (key: SecretKey) {
  const result = yield* runProton("gpg-connect-agent", [
    ...Array.map(key.keygrips, (grip) => `KEYINFO ${grip}`),
    "/bye",
  ]);
  return yield* parseProtection(key, Redacted.value(result.stdout));
});

type Protection = Effect.Success<ReturnType<typeof parseProtection>>;

const mismatch = (
  protection: KeyProtection,
  state: Protection,
  passphraseFile: string,
): Option.Option<BackupError> =>
  protection._tag === "None" && state !== "unprotected"
    ? Option.some(
        BackupError.make({
          message: `The Proton GPG key is passphrase-protected; provide ${passphraseFile}`,
        }),
      )
    : protection._tag === "Passphrase" && state !== "protected"
      ? Option.some(
          BackupError.make({
            message: `The Proton GPG key is not protected by ${passphraseFile}; run proton-login`,
          }),
        )
      : Option.none();

const checkKey = Effect.fn("Proton.checkKey")(function* (
  key: SecretKey,
  protection: KeyProtection,
) {
  const { passphraseFile } = yield* ProtonState;
  const error = mismatch(protection, yield* readProtection(key), passphraseFile);
  if (Option.isSome(error)) {
    return yield* error.value;
  }
  if (!key.encrypts) {
    return yield* BackupError.make({
      message: "The Proton GPG key cannot encrypt; run proton-login to repair it",
    });
  }
});

const createKey = Effect.fn("Proton.createKey")(function* (protection: KeyProtection) {
  yield* runProton("gpg", [
    "--batch",
    ...passphraseArguments(protection),
    "--quick-generate-key",
    `Ankh <${identity}>`,
    "default",
    "default",
    "0",
  ]);
  yield* Effect.logDebug({ event: "proton.key.created" });
  return yield* requireKey();
});

const protectKey = Effect.fn("Proton.protectKey")(function* (
  key: SecretKey,
  protection: KeyProtection,
) {
  const { passphraseFile } = yield* ProtonState;
  const error = mismatch(protection, yield* readProtection(key), passphraseFile);
  if (Option.isNone(error)) {
    return;
  }
  // Never remove a passphrase implicitly; a missing passphrase file must fail closed.
  if (protection._tag === "None") {
    return yield* error.value;
  }
  yield* runProton("gpg", [
    "--batch",
    ...passphraseArguments(protection),
    "--passwd",
    key.fingerprint,
  ]);
  yield* Effect.logDebug({ event: "proton.key.protected" });
});

const repairKey = Effect.fn("Proton.repairKey")(function* (
  key: SecretKey,
  protection: KeyProtection,
) {
  // Sign-only keys from the original prototype need an encryption subkey for pass.
  if (!key.encrypts) {
    yield* runProton("gpg", [
      "--batch",
      ...passphraseArguments(protection),
      "--quick-add-key",
      key.fingerprint,
      "cv25519",
      "encrypt",
      "0",
    ]);
    yield* Effect.logDebug({ event: "proton.key.repaired" });
  }
});

const ensureKey = Effect.fn("Proton.ensureKey")(function* (protection: KeyProtection) {
  const existing = yield* findKey();
  const key = Option.isSome(existing) ? existing.value : yield* createKey(protection);
  yield* protectKey(key, protection);
  yield* repairKey(key, protection);
  const final = yield* requireKey();
  yield* checkKey(final, protection);
  return final.fingerprint;
});

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
