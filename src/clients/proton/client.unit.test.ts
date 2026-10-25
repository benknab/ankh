import { expect, it } from "@effect/vitest";
import {
  Array,
  DateTime,
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Path,
  Record,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { type Argument, Commands, type Options } from "#/process/commands.ts";
import { absolutePath, BackupError, JobName, Proton } from "#/domain/model.ts";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { archiveName } from "#/domain/archive.ts";
import { Storage } from "#/storage/storage.ts";
import { output } from "#/testing/commands.ts";

const destinationConfig = Schema.decodeEffect(Proton)({
  type: "proton-drive",
  remoteFolder: "/my-files/a",
  outbox: "/outbox",
});
const archive = Schema.decodeEffect(JobName)("test-job").pipe(
  Effect.map((job) => archiveName(job, DateTime.makeUnsafe("2026-01-01T00:00:00Z"))),
);
const listing = Effect.fn("Test.listing")((names: Iterable<string>) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
    Array.map(Array.fromIterable(names), (value) => ({ name: { ok: true, value }, type: "file" })),
  ).pipe(Effect.orDie),
);
const protonLayer = (
  commands: Commands["Service"],
  files: Partial<FileSystem.FileSystem> = {},
): Layer.Layer<ProtonDrive> =>
  ProtonDrive.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(Commands, commands),
        Storage.layer.pipe(Layer.provide(Layer.merge(Path.layer, FileSystem.layerNoop(files)))),
      ),
    ),
  );
const failedExit = (exitCode: number, stderr: string): BackupError =>
  BackupError.make({
    message: `flock exited ${exitCode}`,
    operation: "flock",
    exitCode,
    cause: Redacted.make({ stdout: "", stderr }),
  });

it.effect("folder initialization only creates names missing from a successful listing", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const calls = yield* Ref.make<readonly Argument[][]>([]);
    const commands = Commands.of({
      run: (_binary, args) =>
        Ref.update(calls, (all) => [...all, [...args]]).pipe(Effect.as(output("[]"))),
    });
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).initialize(destination);
    }).pipe(Effect.provide(protonLayer(commands)));
    expect(yield* Ref.get(calls), "missing folder must be created").toHaveLength(2);
    const failure = BackupError.make({ message: "authentication failed" });
    const broken = Commands.of({
      run: (_binary, args) =>
        args.includes("create-folder")
          ? Effect.die("must not create on listing failure")
          : Effect.fail(failure),
    });
    const result = yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).initialize(destination);
    }).pipe(Effect.provide(protonLayer(broken)), Effect.result);
    expect(
      Result.isFailure(result) && result.failure === failure,
      "authentication error must be preserved",
    ).toBe(true);
  }),
);

it.effect("Proton commands run under the state lock with a pinned environment", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const calls = yield* Ref.make<
      readonly { binary: string; args: readonly Argument[]; options?: Options }[]
    >([]);
    const commands = Commands.of({
      run: (binary, args, options) =>
        Ref.update(calls, (all) => [
          ...all,
          { binary, args, ...(options === undefined ? {} : { options }) },
        ]).pipe(Effect.as(output("[]"))),
    });
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).list(destination);
    }).pipe(Effect.provide(protonLayer(commands)));
    const [call] = yield* Ref.get(calls);
    expect(call?.binary, "every Proton tool must run through flock").toBe("flock");
    expect(
      call?.options?.extendEnv,
      "Proton must not inherit unrelated secrets or TLS overrides",
    ).toBe(false);
    expect(call?.args.slice(0, 9)).toEqual([
      "--exclusive",
      "--close",
      "--timeout",
      "21600",
      "--conflict-exit-code",
      "75",
      "/proton/lock",
      "proton-drive",
      "filesystem",
    ]);
    expect(call?.options?.env, "inherited variables must not redirect the CLI").toMatchObject({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C.UTF-8",
      PROTON_DRIVE_BASE_URL: "drive-api.proton.me",
      PROTON_DRIVE_CREDENTIALS_STORE: "pass",
      PROTON_DRIVE_UNSAFE_CACHE: "false",
      PASSWORD_STORE_GPG_OPTS: "",
      PASSWORD_STORE_KEY: "",
      PASSWORD_STORE_ENABLE_EXTENSIONS: "false",
    });
  }),
);

it.effect("a passphrase file is passed to pass by path and must be one non-empty line", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const envs = yield* Ref.make<readonly Options["env"][]>([]);
    const commands = Commands.of({
      run: (_binary, _args, options) =>
        Ref.update(envs, (all) => [...all, options?.env]).pipe(Effect.as(output("[]"))),
    });
    const run = (text: string): Effect.Effect<unknown, BackupError> =>
      Effect.gen(function* () {
        return yield* (yield* ProtonDrive).list(destination);
      }).pipe(
        Effect.provide(
          protonLayer(commands, {
            exists: () => Effect.succeed(true),
            readFileString: () => Effect.succeed(text),
          }),
        ),
      );
    yield* run("correct horse\n");
    const [env] = yield* Ref.get(envs);
    expect(env).toMatchObject({
      PASSWORD_STORE_GPG_OPTS:
        "--pinentry-mode loopback --passphrase-file /secrets/proton-gpg-passphrase",
    });
    expect(
      Array.some(
        Record.values(env ?? {}),
        (value) => Redacted.isRedacted(value) || value.includes("correct horse"),
      ),
      "the passphrase itself must never reach the environment",
    ).toBe(false);
    for (const [index, invalid] of ["", "\n", "two\nlines\n", "windows\r\n"].entries()) {
      const result = yield* run(invalid).pipe(Effect.result);
      expect(Result.isFailure(result), `invalid passphrase file ${index} must fail`).toBe(true);
    }
    expect(
      yield* Ref.get(envs),
      "invalid passphrase files must fail before any command",
    ).toHaveLength(1);
  }),
);

it.effect("Proton CLI failures are described without exposing tool output", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const cases = [
      [failedExit(1, "You need to login first\n"), "run proton-login", 1],
      [failedExit(1, "Failed to load session in pass: gpg: decryption failed"), "passphrase", 1],
      [failedExit(75, ""), "Proton state lock", undefined],
      [failedExit(1, "unexpected trace with secrets"), "proton-drive exited 1", 1],
    ] as const;
    for (const [failure, expected, exitCode] of cases) {
      const commands = Commands.of({ run: () => Effect.fail(failure) });
      const result = yield* Effect.gen(function* () {
        return yield* (yield* ProtonDrive).list(destination);
      }).pipe(Effect.provide(protonLayer(commands)), Effect.flip);
      expect(result.message).toContain(expected);
      expect(result.message).not.toContain("secrets");
      expect(result.exitCode).toBe(exitCode);
    }
  }),
);

it.effect("Proton rejects malformed listings and unconfirmed uploads", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const name = yield* archive;
    const directory = absolutePath(`/outbox/${name.slice(0, -".tar.zst".length)}`);
    const commands = Commands.of({ run: () => Effect.succeed(output("[]")) });
    const result = yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).upload(destination, {
        name,
        file: absolutePath(`${directory}/${name}`),
        checksum: absolutePath(`${directory}/${name}.sha256`),
        directory,
      });
    }).pipe(Effect.provide(protonLayer(commands)), Effect.result);
    expect(Result.isFailure(result), "missing remote pair must fail upload confirmation").toBe(
      true,
    );
    for (const invalid of [
      "not json",
      '[{"name":{"ok":false},"type":"file"}]',
      '[{"name":{"ok":true,"value":"duplicate"},"type":"file"},{"name":{"ok":true,"value":"duplicate"},"type":"file"}]',
    ]) {
      const invalidResult = yield* Effect.gen(function* () {
        return yield* (yield* ProtonDrive).list(destination);
      }).pipe(
        Effect.provide(protonLayer(Commands.of({ run: () => Effect.succeed(output(invalid)) }))),
        Effect.result,
      );
      expect(Result.isFailure(invalidResult), "invalid listing must fail closed").toBe(true);
    }
  }),
);

it.effect("Proton trash can resume a known partial deletion", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const name = yield* archive;
    const remaining = yield* Ref.make(HashSet.make(`${name}.sha256`));
    const commands = Commands.of({
      run: (_binary, args) =>
        Effect.gen(function* () {
          if (args.includes("trash")) {
            expect(args, "must only trash files that still exist").not.toContain(
              `${destination.remoteFolder}/${name}`,
            );
            yield* Ref.set(remaining, HashSet.empty());
            return output("[]");
          }
          return output(yield* listing(yield* Ref.get(remaining)));
        }),
    });
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).trash(destination, HashSet.make(name));
    }).pipe(Effect.provide(protonLayer(commands)));
    expect(HashSet.size(yield* Ref.get(remaining)), "remaining checksum must be removed").toBe(0);
  }),
);

it.effect("Proton retention uses two listings and bounded batches for a large deletion", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const names = HashSet.fromIterable(
      Array.makeBy(120, (day) =>
        archiveName(job, DateTime.add(DateTime.makeUnsafe("2025-01-01T00:00:00Z"), { days: day })),
      ),
    );
    let remaining = HashSet.add(
      HashSet.fromIterable(
        Array.flatMap(Array.fromIterable(names), (name) => [name, `${name}.sha256`]),
      ),
      "unrelated.txt",
    );
    let lists = 0;
    const batches: number[] = [];
    const commands = Commands.of({
      run: (_binary, args) =>
        Effect.gen(function* () {
          if (args.includes("trash")) {
            const files = Array.map(args.slice(args.indexOf("--json") + 1), (arg) =>
              Redacted.isRedacted(arg) ? Redacted.value(arg) : arg,
            );
            batches.push(files.length);
            for (const file of files) {
              remaining = HashSet.remove(
                remaining,
                file.slice(destination.remoteFolder.length + 1),
              );
            }
            return output("[]");
          }
          lists += 1;
          return output(yield* listing(remaining));
        }),
    });
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).trash(destination, names);
    }).pipe(Effect.provide(protonLayer(commands)));
    expect(lists).toBe(2);
    expect(batches).toEqual([100, 100, 40]);
    expect(Array.fromIterable(remaining)).toEqual(["unrelated.txt"]);
  }),
);

it.effect("Proton retention retries a failed batch without retrashing removed files", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const names = HashSet.fromIterable(
      Array.makeBy(51, (day) =>
        archiveName(job, DateTime.add(DateTime.makeUnsafe("2025-01-01T00:00:00Z"), { days: day })),
      ),
    );
    let remaining = HashSet.fromIterable(
      Array.flatMap(Array.fromIterable(names), (name) => [name, `${name}.sha256`]),
    );
    let batches = 0;
    const commands = Commands.of({
      run: (_binary, args) =>
        Effect.gen(function* () {
          if (!args.includes("trash")) {
            return output(yield* listing(remaining));
          }
          batches += 1;
          if (batches === 2) {
            return yield* BackupError.make({ message: "injected batch failure" });
          }
          for (const arg of args.slice(args.indexOf("--json") + 1)) {
            const file = (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg).slice(
              destination.remoteFolder.length + 1,
            );
            expect(HashSet.has(remaining, file), "retry must skip files already removed").toBe(
              true,
            );
            remaining = HashSet.remove(remaining, file);
          }
          return output("[]");
        }),
    });
    yield* Effect.gen(function* () {
      const proton = yield* ProtonDrive;
      const failure = yield* proton.trash(destination, names).pipe(Effect.flip);
      expect(failure.message).toBe("injected batch failure");
      expect(HashSet.size(remaining)).toBe(2);
      yield* proton.trash(destination, names);
    }).pipe(Effect.provide(protonLayer(commands)));
    expect(batches).toBe(3);
    expect(HashSet.size(remaining)).toBe(0);
  }),
);

it.effect("Proton retention rejects a successful trash command that leaves a checksum", () =>
  Effect.gen(function* () {
    const destination = yield* destinationConfig;
    const name = yield* archive;
    let trashed = false;
    const commands = Commands.of({
      run: (_binary, args) =>
        Effect.gen(function* () {
          if (args.includes("trash")) {
            trashed = true;
            return output("[]");
          }
          return output(yield* listing(trashed ? [`${name}.sha256`] : [name, `${name}.sha256`]));
        }),
    });
    const failure = yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).trash(destination, HashSet.make(name));
    }).pipe(Effect.provide(protonLayer(commands)), Effect.flip);
    expect(trashed).toBe(true);
    expect(failure.message).toBe(`Proton did not confirm trashing ${name}`);
  }),
);
