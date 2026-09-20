import { Context, Effect, HashSet, Layer, Schema } from "effect";
import { Commands } from "./commands.ts";
import { type ArchiveName, BackupError, type Proton } from "./model.ts";
import { type Archive } from "./outbox.ts";
import { RemoteNodes } from "./retention.ts";

export const protonEnvironment = {
  GNUPGHOME: "/proton/gnupg",
  HOME: "/tmp",
  PASSWORD_STORE_DIR: "/proton/pass",
  PROTON_DRIVE_CACHE_DIR: "/proton/cache",
  PROTON_DRIVE_CREDENTIALS_STORE: "pass",
  PROTON_DRIVE_LOG_LEVEL: "WARNING",
};

export class ProtonDrive extends Context.Service<ProtonDrive, {
  readonly initialize: (
    destination: Proton,
  ) => Effect.Effect<void, BackupError>;
  readonly list: (
    destination: Proton,
  ) => Effect.Effect<HashSet.HashSet<string>, BackupError>;
  readonly upload: (
    destination: Proton,
    archive: Archive,
  ) => Effect.Effect<void, BackupError>;
  readonly trash: (
    destination: Proton,
    names: HashSet.HashSet<ArchiveName>,
  ) => Effect.Effect<void, BackupError>;
}>()("backup-runner/ProtonDrive") {
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
          const nodes = yield* Schema.decodeUnknownEffect(RemoteNodes)(
            yield* run([
              "list",
              "--json",
              "--type",
              "file",
              destination.remoteFolder,
            ]),
          );
          return HashSet.fromIterable(nodes.map((node) => node.name.value));
        },
        Effect.mapError((e) => new BackupError({ message: String(e) })),
      );
      const initialize = Effect.fn("ProtonDrive.initialize")(
        function* (destination: Proton) {
          let parent = "/my-files";
          for (
            const name of destination.remoteFolder.slice("/my-files/".length)
              .split("/")
          ) {
            const current = `${parent}/${name}`;
            yield* run(["info", current]).pipe(
              Effect.catch(() => run(["create-folder", parent, name])),
            );
            parent = current;
          }
        },
      );
      const upload = Effect.fn("ProtonDrive.upload")(
        function* (destination: Proton, archive: Archive) {
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
          if (
            !HashSet.has(names, archive.name) ||
            !HashSet.has(names, `${archive.name}.sha256`)
          ) {
            return yield* new BackupError({
              message: `Proton did not confirm archive pair ${archive.name}`,
            });
          }
        },
      );
      const trash = Effect.fn("ProtonDrive.trash")(
        function* (destination: Proton, names: HashSet.HashSet<ArchiveName>) {
          for (const name of names) {
            const pair = [name, `${name}.sha256`];
            yield* run([
              "trash",
              "--json",
              ...pair.map((file) => `${destination.remoteFolder}/${file}`),
            ]);
            const remaining = yield* list(destination);
            if (pair.some((file) => HashSet.has(remaining, file))) {
              return yield* new BackupError({
                message: `Proton did not confirm trashing ${name}`,
              });
            }
          }
        },
      );
      return ProtonDrive.of({ initialize, list, upload, trash });
    }),
  );
}
