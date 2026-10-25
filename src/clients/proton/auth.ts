import { Effect } from "effect";
import { backupError } from "#domain/model.ts";
import { runProton } from "#clients/proton/command.ts";
import { ensureKey } from "#clients/proton/credentials.ts";
import { ProtonState } from "#clients/proton/state.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

export const login = Effect.fn("Proton.login")(
  function* () {
    const { fs } = yield* Storage;
    const { gnupg, passwordStore, cache } = yield* ProtonState;
    yield* Effect.forEach([gnupg, passwordStore, cache], privateDirectory, {
      discard: true,
    }).pipe(Effect.mapError(backupError("Proton state directories")));
    const fingerprint = yield* ensureKey();
    const initialized = yield* fs
      .exists(`${passwordStore}/.gpg-id`)
      .pipe(Effect.mapError(backupError("Proton password store")));
    if (!initialized) {
      yield* runProton("pass", ["init", fingerprint]);
    }
    yield* runProton("proton-drive", ["auth", "login"], { interactive: true });
  },
  Effect.tapError((error) => Effect.logWarning(error.message)),
);
