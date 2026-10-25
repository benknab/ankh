import { it } from "@effect/vitest";
import { Effect } from "effect";
import { login } from "../src/auth.ts";
import { Commands } from "../src/commands.ts";
import { protonEnvironment } from "../src/proton-state.ts";
import { Storage } from "../src/storage.ts";
import { infrastructure } from "./integration-support.ts";
import { assert } from "./support.ts";

it.live("Proton credential setup creates a usable encryption key", () =>
  Effect.gen(function* () {
    const commands = yield* Commands;
    const { fs } = yield* Storage;
    const testCommands = Commands.of({
      run: (binary, args, options) =>
        binary === "proton-drive"
          ? Effect.succeed("login skipped in test")
          : commands.run(binary, args, options),
    });
    yield* login().pipe(Effect.provideService(Commands, testCommands));
    yield* fs.writeFileString("/proton/probe", "credential-round-trip", { mode: 0o600 });
    yield* commands.run(
      "gpg",
      [
        "--batch",
        "--yes",
        "--recipient",
        "backup-runner@localhost",
        "--output",
        "/proton/probe.gpg",
        "--encrypt",
        "/proton/probe",
      ],
      { env: protonEnvironment },
    );
    const decrypted = yield* commands.run("gpg", ["--batch", "--decrypt", "/proton/probe.gpg"], {
      env: protonEnvironment,
    });
    yield* assert(
      decrypted === "credential-round-trip",
      "session encryption key must support decryption",
    );
    // A second login setup must reuse the existing key and store.
    yield* login().pipe(Effect.provideService(Commands, testCommands));
  }).pipe(Effect.provide(infrastructure)),
);
