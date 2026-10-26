import { Array, Context, Effect, HashSet, Layer } from "effect";
import { type ArchiveName, BackupError, type Proton, type RemoteFolder } from "#/domain/model.ts";
import type { Archive } from "#/domain/archive.ts";
import { ProtonCli } from "#/clients/proton/cli.ts";

type Folder = Pick<Proton, "remoteFolder">;

const rootFolder = (folder: RemoteFolder): string =>
  folder.startsWith("/my-files/") ? "/my-files" : Array.join(folder.split("/").slice(0, 3), "/");

// The CLI resolves shared roots by name. Check every operation, including checks and
// retention retries that do not initialize folders, rather than caching access.
const withFolder = Effect.fn("ProtonDrive.withFolder")(function* <A>(
  cli: ProtonCli["Service"],
  destination: Folder,
  operation: Effect.Effect<A, BackupError>,
) {
  const root = rootFolder(destination.remoteFolder);
  if (root !== "/my-files") {
    const folders = yield* cli.list("/shared-with-me", "folder");
    if (!HashSet.has(folders, root.slice("/shared-with-me/".length))) {
      return yield* BackupError.make({
        message:
          "Proton shared folder is unavailable; accept its invitation with the backup account and check remoteFolder and Editor access",
      });
    }
  }
  return yield* operation;
});

const initialize = Effect.fn("ProtonDrive.initialize")(function* (
  cli: ProtonCli["Service"],
  destination: Folder,
) {
  let parent = rootFolder(destination.remoteFolder);
  const names = destination.remoteFolder.slice(parent.length + 1);
  for (const name of names === "" ? [] : names.split("/")) {
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
        initialize: (destination) => withFolder(cli, destination, initialize(cli, destination)),
        list: (destination) =>
          withFolder(cli, destination, cli.list(destination.remoteFolder, "file")),
        upload: (destination, archive) =>
          withFolder(cli, destination, upload(cli, destination, archive)),
        trash: (destination, names) => withFolder(cli, destination, trash(cli, destination, names)),
      });
    }),
  ).pipe(Layer.provide(ProtonCli.layer));
}
