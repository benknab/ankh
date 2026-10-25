import { Array, Context, Effect, HashSet, Layer } from "effect";
import { type ArchiveName, BackupError, type Proton } from "#/domain/model.ts";
import type { Archive } from "#/domain/archive.ts";
import { ProtonCli } from "#/clients/proton/cli.ts";

type Folder = Pick<Proton, "remoteFolder">;

const initialize = Effect.fn("ProtonDrive.initialize")(function* (
  cli: ProtonCli["Service"],
  destination: Folder,
) {
  let parent = "/my-files";
  for (const name of destination.remoteFolder.slice("/my-files/".length).split("/")) {
    const folders = yield* cli.list(parent, "folder");
    if (!HashSet.has(folders, name)) {
      yield* cli.createFolder(parent, name);
    }
    parent = `${parent}/${name}`;
  }
});

const upload = Effect.fn("ProtonDrive.upload")(function* (
  cli: ProtonCli["Service"],
  destination: Folder,
  archive: Archive,
) {
  yield* cli.upload(destination.remoteFolder, [archive.file, archive.checksum]);
  const names = yield* cli.list(destination.remoteFolder, "file");
  if (!HashSet.has(names, archive.name) || !HashSet.has(names, `${archive.name}.sha256`)) {
    return yield* BackupError.make({
      message: `Proton did not confirm archive pair ${archive.name}`,
    });
  }
});

const trashBatch = Effect.fn("ProtonDrive.trashBatch")(function* (
  cli: ProtonCli["Service"],
  destination: Folder,
  pending: readonly string[],
) {
  if (pending.length > 0) {
    yield* cli.trash(Array.map(pending, (file) => `${destination.remoteFolder}/${file}`));
  }
});

const trash = Effect.fn("ProtonDrive.trash")(function* (
  cli: ProtonCli["Service"],
  destination: Folder,
  names: HashSet.HashSet<ArchiveName>,
) {
  if (HashSet.size(names) === 0) {
    return;
  }
  const existing = yield* cli.list(destination.remoteFolder, "file");
  // Bound command arguments while sharing folder listings across the whole retention intent.
  for (const batch of Array.chunksOf(Array.fromIterable(names), 50)) {
    const pending = Array.filter(
      Array.flatMap(batch, (name) => [name, `${name}.sha256`]),
      (file) => HashSet.has(existing, file),
    );
    yield* trashBatch(cli, destination, pending);
  }
  const remaining = yield* cli.list(destination.remoteFolder, "file");
  for (const name of names) {
    if (HashSet.has(remaining, name) || HashSet.has(remaining, `${name}.sha256`)) {
      return yield* BackupError.make({ message: `Proton did not confirm trashing ${name}` });
    }
  }
});

export class ProtonDrive extends Context.Service<
  ProtonDrive,
  {
    readonly verify: Effect.Effect<void, BackupError>;
    readonly initialize: (destination: Folder) => Effect.Effect<void, BackupError>;
    readonly list: (destination: Folder) => Effect.Effect<HashSet.HashSet<string>, BackupError>;
    readonly upload: (destination: Folder, archive: Archive) => Effect.Effect<void, BackupError>;
    readonly trash: (
      destination: Folder,
      names: HashSet.HashSet<ArchiveName>,
    ) => Effect.Effect<void, BackupError>;
  }
>()("ankh/clients/proton/client/ProtonDrive") {
  public static readonly layer = Layer.effect(
    ProtonDrive,
    Effect.gen(function* () {
      const cli = yield* ProtonCli;
      return ProtonDrive.of({
        verify: cli.verify,
        initialize: (destination) => initialize(cli, destination),
        list: (destination) => cli.list(destination.remoteFolder, "file"),
        upload: (destination, archive) => upload(cli, destination, archive),
        trash: (destination, names) => trash(cli, destination, names),
      });
    }),
  ).pipe(Layer.provide(ProtonCli.layer));
}
