import { Effect } from "effect";
import { backupError } from "#domain/model.ts";
import { runProton } from "#clients/proton/command.ts";
import { setupCredentials } from "#clients/proton/credentials.ts";
import { ProtonState } from "#clients/proton/state.ts";
import { privateDirectory } from "#storage/storage.ts";

export const login = Effect.fn("Proton.login")(
  function* () {
    const { gnupg, passwordStore, cache } = yield* ProtonState;
    yield* Effect.forEach([gnupg, passwordStore, cache], privateDirectory, {
      discard: true,
    }).pipe(Effect.mapError(backupError("Proton state directories")));
    yield* setupCredentials();
    yield* runProton("proton-drive", ["auth", "login"], { interactive: true });
  },
  Effect.tapError((error) => Effect.logWarning(error.message)),
);
