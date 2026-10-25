import { expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Redacted, Ref, Result } from "effect";
import { login } from "#clients/proton/auth.ts";
import { runProton } from "#clients/proton/command.ts";
import { verifyCredentials } from "#clients/proton/credentials.ts";
import {
  passphraseArguments,
  type ProtonPaths,
  ProtonState,
  protonEnvironment,
} from "#clients/proton/state.ts";
import { absolutePath, type BackupError } from "#domain/model.ts";
import { Commands, type Options } from "#process/commands.ts";
import { Storage } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";
import { output } from "#testing/commands.ts";

// Each scenario gets private GnuPG and pass state, and stops its agent afterwards.
const isolated = Effect.fn("Test.isolatedProtonState")(function* () {
  const { fs, path } = yield* Storage;
  const commands = yield* Commands;
  const root = yield* fs.makeTempDirectoryScoped();
  const paths: ProtonPaths = {
    gnupg: absolutePath(path.join(root, "gnupg")),
    passwordStore: absolutePath(path.join(root, "pass")),
    cache: absolutePath(path.join(root, "cache")),
    lock: absolutePath(path.join(root, "lock")),
    passphraseFile: absolutePath(path.join(root, "proton-gpg-passphrase")),
    lockTimeout: Duration.seconds(1),
  };
  yield* Effect.addFinalizer(() =>
    commands
      .run("gpgconf", ["--kill", "gpg-agent"], { env: { GNUPGHOME: paths.gnupg } })
      .pipe(Effect.ignore),
  );
  return paths;
});

// Replace only the browser login; GnuPG, pass, and flock run for real.
const stubbedLogin = Effect.fn("Test.stubbedLogin")(function* () {
  const commands = yield* Commands;
  const logins = yield* Ref.make<readonly Options[]>([]);
  const testCommands = Commands.of({
    run: (binary, args, options) =>
      binary === "flock" && args.includes("proton-drive")
        ? Ref.update(logins, (all) => [...all, options ?? {}]).pipe(
            Effect.as(output("login skipped in test")),
          )
        : commands.run(binary, args, options),
  });
  return {
    logins,
    run: login().pipe(Effect.provideService(Commands, testCommands)),
  };
});

const messageOf = (result: Result.Result<unknown, BackupError>): string =>
  Result.isFailure(result) ? result.failure.message : "";

it.live("unprotected Proton credential setup creates a usable private store", () =>
  Effect.gen(function* () {
    const paths = yield* ProtonState;
    const { fs } = yield* Storage;
    const commands = yield* Commands;
    const { logins, run } = yield* stubbedLogin();
    yield* run;
    yield* verifyCredentials();
    const [options] = yield* Ref.get(logins);
    expect(options?.interactive, "the browser login must use the terminal").toBe(true);
    for (const directory of [paths.gnupg, paths.passwordStore, paths.cache]) {
      expect(((yield* fs.stat(directory)).mode & 0o777).toString(8)).toBe("700");
    }
    expect(
      yield* fs.exists(`${paths.passwordStore}/ankh-probe.gpg`),
      "the store probe must be removed",
    ).toBe(false);
    expect(yield* fs.readFileString(`${paths.gnupg}/gpg-agent.conf`)).toBe(
      "default-cache-ttl 0\nmax-cache-ttl 0\n",
    );
    const env = protonEnvironment(paths, { _tag: "None" });
    const probe = `${paths.cache}/probe`;
    yield* fs.writeFileString(probe, "credential-round-trip", { mode: 0o600 });
    yield* commands.run(
      "gpg",
      ["--batch", "--yes", "--recipient", "backup-runner@localhost", "--encrypt", probe],
      { env },
    );
    const decrypted = yield* commands.run("gpg", ["--batch", "--decrypt", `${probe}.gpg`], {
      env,
    });
    expect(Redacted.value(decrypted.stdout)).toBe("credential-round-trip");
    const recipients = yield* fs.readFileString(`${paths.passwordStore}/.gpg-id`);
    yield* run;
    expect(
      yield* fs.readFileString(`${paths.passwordStore}/.gpg-id`),
      "a second login must reuse the key and store",
    ).toBe(recipients);
    expect(yield* Ref.get(logins)).toHaveLength(2);
  }).pipe(Effect.provideServiceEffect(ProtonState, isolated()), Effect.provide(infrastructure)),
);

it.live("a passphrase file protects new keys and must stay available", () =>
  Effect.gen(function* () {
    const paths = yield* ProtonState;
    const { fs } = yield* Storage;
    const { logins, run } = yield* stubbedLogin();
    yield* fs.writeFileString(paths.passphraseFile, "correct horse battery\n", { mode: 0o600 });
    yield* run;
    yield* verifyCredentials();
    yield* fs.remove(paths.passphraseFile);
    const verified = yield* verifyCredentials().pipe(Effect.result);
    expect(messageOf(verified), "a missing passphrase file must fail closed").toContain(
      "passphrase-protected",
    );
    const relogin = yield* run.pipe(Effect.result);
    expect(messageOf(relogin), "login must never remove the passphrase").toContain(
      "passphrase-protected",
    );
    expect(yield* Ref.get(logins), "failed setup must not start a browser login").toHaveLength(1);
    yield* fs.writeFileString(paths.passphraseFile, "wrong passphrase\n", { mode: 0o600 });
    const wrong = yield* run.pipe(Effect.result);
    expect(Result.isFailure(wrong), "a wrong passphrase must fail the store probe").toBe(true);
    expect(yield* Ref.get(logins)).toHaveLength(1);
  }).pipe(Effect.provideServiceEffect(ProtonState, isolated()), Effect.provide(infrastructure)),
);

it.live("adding a passphrase file protects an existing key on the next login", () =>
  Effect.gen(function* () {
    const paths = yield* ProtonState;
    const { fs } = yield* Storage;
    const commands = yield* Commands;
    const { run } = yield* stubbedLogin();
    yield* run;
    yield* runProton("pass", ["insert", "--force", "--multiline", "existing-entry"]);
    yield* fs.writeFileString(paths.passphraseFile, "correct horse battery\n", { mode: 0o600 });
    const stale = yield* verifyCredentials().pipe(Effect.result);
    expect(messageOf(stale), "runs must not silently ignore a new passphrase").toContain(
      "run proton-login",
    );
    yield* run;
    yield* verifyCredentials();
    yield* runProton("pass", ["show", "existing-entry"]);
    // The agent stays running, so this also proves it did not cache the passphrase.
    const unprotected = yield* commands
      .run("pass", ["show", "existing-entry"], {
        env: protonEnvironment(paths, { _tag: "None" }),
      })
      .pipe(Effect.result);
    expect(Result.isFailure(unprotected), "the key must require the passphrase").toBe(true);
  }).pipe(Effect.provideServiceEffect(ProtonState, isolated()), Effect.provide(infrastructure)),
);

it.live("a password store for another key fails before the browser login", () =>
  Effect.gen(function* () {
    const paths = yield* ProtonState;
    const { fs } = yield* Storage;
    const { logins, run } = yield* stubbedLogin();
    yield* run;
    yield* fs.writeFileString(`${paths.passwordStore}/.gpg-id`, `${"0".repeat(40)}\n`);
    const result = yield* run.pipe(Effect.result);
    expect(messageOf(result)).toContain("different key");
    expect(messageOf(yield* verifyCredentials().pipe(Effect.result))).toContain("different key");
    expect(yield* Ref.get(logins), "mismatched stores must not start a login").toHaveLength(1);
  }).pipe(Effect.provideServiceEffect(ProtonState, isolated()), Effect.provide(infrastructure)),
);

it.live("a sign-only legacy key is repaired under the configured passphrase", () =>
  Effect.gen(function* () {
    const paths = yield* ProtonState;
    const { fs } = yield* Storage;
    const { run } = yield* stubbedLogin();
    yield* fs.writeFileString(paths.passphraseFile, "correct horse battery\n", { mode: 0o600 });
    yield* fs.makeDirectory(paths.gnupg, { mode: 0o700 });
    yield* runProton("gpg", [
      "--batch",
      ...passphraseArguments({ _tag: "Passphrase", file: paths.passphraseFile }),
      "--quick-generate-key",
      "Backup Runner <backup-runner@localhost>",
      "ed25519",
      "sign",
      "0",
    ]);
    yield* run;
    yield* verifyCredentials();
  }).pipe(Effect.provideServiceEffect(ProtonState, isolated()), Effect.provide(infrastructure)),
);

it.live("Proton commands wait for the shared state lock and report timeouts", () =>
  Effect.gen(function* () {
    const paths = yield* ProtonState;
    const commands = yield* Commands;
    const holder = yield* commands
      .run("flock", ["--exclusive", paths.lock, "sleep", "3"])
      .pipe(Effect.forkScoped);
    yield* Effect.sleep("500 millis");
    const blocked = yield* runProton("gpg", ["--version"]).pipe(Effect.result);
    expect(messageOf(blocked), "a held lock must time out with a clear error").toContain(
      "Proton state lock",
    );
    yield* Fiber.join(holder);
    yield* runProton("gpg", ["--version"]);
  }).pipe(Effect.provideServiceEffect(ProtonState, isolated()), Effect.provide(infrastructure)),
);
