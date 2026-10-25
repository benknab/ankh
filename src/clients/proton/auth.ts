import { Effect, Record } from "effect";
import { Commands } from "#process/commands.ts";
import { ensureKey } from "#clients/proton/credentials.ts";
import { protonEnvironment, protonPaths } from "#clients/proton/state.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

export const login = Effect.fn("Proton.login")(function* () {
  const commands = yield* Commands;
  const { fs } = yield* Storage;
  yield* Effect.forEach(Record.values(protonPaths), privateDirectory, { discard: true });
  const fingerprint = yield* ensureKey();
  if (!(yield* fs.exists(`${protonPaths.passwordStore}/.gpg-id`))) {
    yield* commands.run("pass", ["init", fingerprint], { env: protonEnvironment });
  }
  yield* commands.run("proton-drive", ["auth", "login"], {
    env: protonEnvironment,
    interactive: true,
  });
});
