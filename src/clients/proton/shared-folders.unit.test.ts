import { expect, it } from "@effect/vitest";
import { Array, DateTime, Effect, FileSystem, HashSet, Layer, Path, Schema } from "effect";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { absolutePath, BackupError, JobName, Proton } from "#/domain/model.ts";
import { archiveName } from "#/domain/archive.ts";
import { type Argument, Commands } from "#/process/commands.ts";
import { Storage } from "#/storage/storage.ts";
import { output } from "#/testing/commands.ts";

const destination = (remoteFolder: string): Effect.Effect<Proton, Schema.SchemaError> =>
  Schema.decodeEffect(Proton)({ type: "proton-drive", remoteFolder, outbox: "/outbox" });
const node = (value: string, type: "folder" | "file" = "folder"): unknown => ({
  name: { ok: true, value },
  type,
});
const listing = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const layer = (commands: Commands["Service"]): Layer.Layer<ProtonDrive> =>
  ProtonDrive.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(Commands, commands),
        Storage.layer.pipe(Layer.provide(Layer.merge(Path.layer, FileSystem.layerNoop({})))),
      ),
    ),
  );

it.effect("shared initialization creates only missing descendants of the invited folder", () =>
  Effect.gen(function* () {
    const config = yield* destination("/shared-with-me/Ankh Backups/host/job");
    const shared = yield* listing([node("unrelated.txt", "file"), node("Ankh Backups")]);
    const host = yield* listing([node("owner-file.txt", "file"), node("host")]);
    const calls: (readonly Argument[])[] = [];
    const commands = Commands.of({
      run: (_binary, args) => {
        const command = args.slice(9);
        calls.push(command);
        return Effect.succeed(
          output(
            command.at(-1) === "/shared-with-me"
              ? shared
              : command.at(-1) === "/shared-with-me/Ankh Backups"
                ? host
                : "[]",
          ),
        );
      },
    });
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).initialize(config);
    }).pipe(Effect.provide(layer(commands)));
    expect(calls).toEqual([
      ["list", "--json", "--type", "folder", "/shared-with-me"],
      ["list", "--json", "--type", "folder", "/shared-with-me/Ankh Backups"],
      ["list", "--json", "--type", "folder", "/shared-with-me/Ankh Backups/host"],
      ["create-folder", "/shared-with-me/Ankh Backups/host", "job"],
    ]);
    calls.length = 0;
    const root = yield* destination("/shared-with-me/Ankh Backups");
    yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).initialize(root);
    }).pipe(Effect.provide(layer(commands)));
    expect(calls, "using the shared root directly must not try to recreate it").toEqual([
      ["list", "--json", "--type", "folder", "/shared-with-me"],
    ]);
  }),
);

it.effect("missing, ambiguous, and unreadable shares block every operation before traversal", () =>
  Effect.gen(function* () {
    const config = yield* destination("/shared-with-me/Ankh Backups/host/job");
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const name = archiveName(job, DateTime.makeUnsafe("2026-01-01T00:00:00Z"));
    const archive = {
      name,
      directory: absolutePath("/outbox/pair"),
      file: absolutePath(`/outbox/pair/${name}`),
      checksum: absolutePath(`/outbox/pair/${name}.sha256`),
    };
    for (const [nodes, reason] of [
      [[], "accept its invitation"],
      [[node("different folder")], "accept its invitation"],
      [[node("Ankh Backups", "file")], "accept its invitation"],
      [[node("Ankh Backups"), node("Ankh Backups")], "duplicate names"],
      [[node("Ankh Backups", "file"), node("Ankh Backups")], "duplicate names"],
      [[{ name: { ok: false }, type: "folder" }], "Proton listing"],
    ] as const) {
      const text = yield* listing(nodes);
      let calls = 0;
      const commands = Commands.of({
        run: (_binary, args) => {
          expect(args.slice(9)).toEqual(["list", "--json", "--type", "folder", "/shared-with-me"]);
          calls += 1;
          return Effect.succeed(output(text));
        },
      });
      yield* Effect.gen(function* () {
        const proton = yield* ProtonDrive;
        for (const operation of [
          proton.initialize(config),
          proton.list(config),
          proton.upload(config, archive),
          proton.trash(config, HashSet.make(name)),
        ]) {
          const failure = yield* operation.pipe(Effect.flip);
          expect(failure.message).toContain(reason);
        }
      }).pipe(Effect.provide(layer(commands)));
      expect(calls).toBe(4);
    }
  }),
);

it.effect("revoking a share after initialization prevents subsequent access", () =>
  Effect.gen(function* () {
    const config = yield* destination("/shared-with-me/Ankh Backups");
    const shared = yield* listing([node("Ankh Backups")]);
    let available = true;
    let checks = 0;
    const commands = Commands.of({
      run: (_binary, args) => {
        expect(args.at(-1)).toBe("/shared-with-me");
        checks += 1;
        return Effect.succeed(output(available ? shared : "[]"));
      },
    });
    yield* Effect.gen(function* () {
      const proton = yield* ProtonDrive;
      yield* proton.initialize(config);
      available = false;
      const failure = yield* proton.list(config).pipe(Effect.flip);
      expect(failure.message).toContain("shared folder is unavailable");
    }).pipe(Effect.provide(layer(commands)));
    expect(checks).toBe(2);
  }),
);

it.effect("every shared operation rejects missing or ambiguous descendant folders", () =>
  Effect.gen(function* () {
    const config = yield* destination("/shared-with-me/Ankh Backups/host/job");
    const job = yield* Schema.decodeEffect(JobName)("test-job");
    const name = archiveName(job, DateTime.makeUnsafe("2026-01-01T00:00:00Z"));
    const archive = {
      name,
      directory: absolutePath("/outbox/pair"),
      file: absolutePath(`/outbox/pair/${name}`),
      checksum: absolutePath(`/outbox/pair/${name}.sha256`),
    };
    const shared = yield* listing([node("Ankh Backups")]);
    const host = yield* listing([node("host")]);
    for (const [nodes, reason] of [
      [[], "destination folder is unavailable"],
      [[node("job", "file")], "destination folder is unavailable"],
      [[node("job"), node("job")], "duplicate names"],
      [[node("job"), node("job", "file")], "duplicate names"],
      [[{ name: { ok: false }, type: "folder" }], "Proton listing"],
    ] as const) {
      const children = yield* listing(nodes);
      const calls: (readonly Argument[])[] = [];
      const commands = Commands.of({
        run: (_binary, args) => {
          const command = args.slice(9);
          expect(command.slice(0, 4)).toEqual(["list", "--json", "--type", "folder"]);
          const parent = command.at(-1);
          expect([
            "/shared-with-me",
            "/shared-with-me/Ankh Backups",
            "/shared-with-me/Ankh Backups/host",
          ]).toContain(parent);
          calls.push(command);
          return Effect.succeed(
            output(
              parent === "/shared-with-me"
                ? shared
                : parent === "/shared-with-me/Ankh Backups"
                  ? host
                  : children,
            ),
          );
        },
      });
      yield* Effect.gen(function* () {
        const proton = yield* ProtonDrive;
        for (const operation of [
          proton.list(config),
          proton.upload(config, archive),
          proton.trash(config, HashSet.make(name)),
        ]) {
          const failure = yield* operation.pipe(Effect.flip);
          expect(failure.message).toContain(reason);
        }
      }).pipe(Effect.provide(layer(commands)));
      expect(calls).toHaveLength(9);
    }
  }),
);

it.effect("shared listing failures preserve the error and never create a replacement root", () =>
  Effect.gen(function* () {
    const config = yield* destination("/shared-with-me/Ankh Backups/job");
    const failure = BackupError.make({ message: "injected network failure" });
    const calls: (readonly Argument[])[] = [];
    const commands = Commands.of({
      run: (_binary, args) => {
        calls.push(args);
        return Effect.fail(failure);
      },
    });
    const result = yield* Effect.gen(function* () {
      yield* (yield* ProtonDrive).initialize(config);
    }).pipe(Effect.provide(layer(commands)), Effect.flip);
    expect(result).toBe(failure);
    expect(calls).toHaveLength(1);
    expect(Array.some(calls, (args) => args.includes("create-folder"))).toBe(false);
  }),
);
