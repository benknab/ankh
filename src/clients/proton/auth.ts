import { Effect } from "effect";
import { runProton } from "#clients/proton/command.ts";
import { ensureKey } from "#clients/proton/credentials.ts";
import { ProtonState } from "#clients/proton/state.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

export const login = Effect.fn("Proton.login")(function* () {
  const { fs } = yield* Storage;
  const { gnupg, passwordStore, cache } = yield* ProtonState;
  yield* Effect.forEach([gnupg, passwordStore, cache], privateDirectory, { discard: true });
  const fingerprint = yield* ensureKey();
  if (!(yield* fs.exists(`${passwordStore}/.gpg-id`))) {
    yield* runProton("pass", ["init", fingerprint]);
  }
  yield* runProton("proton-drive", ["auth", "login"], { interactive: true });
});
