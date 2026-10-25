import { Context, Effect, HashSet, Layer, Schema } from "effect";
import { Commands } from "../../process/commands.ts";
import { type ArchiveName, BackupError, backupError, type Proton } from "../../domain/model.ts";
import { type Archive } from "../../domain/archive.ts";

import { protonEnvironment } from "./state.ts";

const Folders = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.Struct({ ok: Schema.Literal(true), value: Schema.NonEmptyString }),
      type: Schema.Literal("folder"),
    }),
  ),
);
const RemoteNodes = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.Struct({ ok: Schema.Literal(true), value: Schema.NonEmptyString }),
      type: Schema.Literal("file"),
    }),
  ),
);

export class ProtonDrive extends Context.Service<
  ProtonDrive,
  {
    readonly initialize: (destination: Proton) => Effect.Effect<void, BackupError>;
    readonly list: (destination: Proton) => Effect.Effect<HashSet.HashSet<string>, BackupError>;
    readonly upload: (destination: Proton, archive: Archive) => Effect.Effect<void, BackupError>;
    readonly trash: (
      destination: Proton,
      names: HashSet.HashSet<ArchiveName>,
    ) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/ProtonDrive") {
  static readonly layer = Layer.effect(
    ProtonDrive,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const run = (args: readonly string[]) =>
        commands.run("proton-drive", ["filesystem", ...args], {
          env: protonEnvironment,
        });
      const list = Effect.fn("ProtonDrive.list")(
        function* (destination: Proton) {
          const nodes = yield* Schema.decodeEffect(RemoteNodes)(
            yield* run(["list", "--json", "--type", "file", destination.remoteFolder]),
          );
          return HashSet.fromIterable(nodes.map((node) => node.name.value));
        },
        Effect.mapError(backupError("Proton listing")),
      );
      const initialize = Effect.fn("ProtonDrive.initialize")(function* (destination: Proton) {
        let parent = "/my-files";
        for (const name of destination.remoteFolder.slice("/my-files/".length).split("/")) {
          const current = `${parent}/${name}`;
          const folders = yield* Schema.decodeEffect(Folders)(
            yield* run(["list", "--json", "--type", "folder", parent]),
          ).pipe(
            Effect.mapError(() => new BackupError({ message: "Invalid Proton folder listing" })),
          );
          if (!folders.some((folder) => folder.name.value === name)) {
            yield* run(["create-folder", parent, name]);
          }
          parent = current;
        }
      });
      const upload = Effect.fn("ProtonDrive.upload")(function* (
        destination: Proton,
        archive: Archive,
      ) {
        yield* run([
          "upload",
          "--file-conflict-strategy",
          "create-new-revision",
          "--skip-thumbnails",
          archive.file,
          archive.checksum,
          destination.remoteFolder,
        ]);
        const names = yield* list(destination);
        if (!HashSet.has(names, archive.name) || !HashSet.has(names, `${archive.name}.sha256`)) {
          return yield* new BackupError({
            message: `Proton did not confirm archive pair ${archive.name}`,
          });
        }
      });
      const trash = Effect.fn("ProtonDrive.trash")(function* (
        destination: Proton,
        names: HashSet.HashSet<ArchiveName>,
      ) {
        for (const name of names) {
          const pair = [name, `${name}.sha256`];
          const existing = yield* list(destination);
          const pending = pair.filter((file) => HashSet.has(existing, file));
          if (pending.length > 0) {
            yield* run([
              "trash",
              "--json",
              ...pending.map((file) => `${destination.remoteFolder}/${file}`),
            ]);
          }
          const remaining = yield* list(destination);
          if (pair.some((file) => HashSet.has(remaining, file))) {
            return yield* new BackupError({
              message: `Proton did not confirm trashing ${name}`,
            });
          }
        }
      });
      return ProtonDrive.of({ initialize, list, upload, trash });
    }),
  );
}
