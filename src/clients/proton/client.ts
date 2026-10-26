import { Array, Context, Effect, HashSet, Layer } from "effect";
import {
  type ArchiveName,
  BackupError,
  type Proton,
  type ProtonFolderIdentity,
  protonFolderIdentity,
  type RemoteFolder,
} from "#/domain/model.ts";
import type { Archive } from "#/domain/archive.ts";
import { ProtonCli } from "#/clients/proton/cli.ts";
import {
  resolveSharedFolder,
  type SharedFolderPath,
  trashSharedFiles,
} from "#/clients/proton/shared.ts";

type Folder = Pick<Proton, "remoteFolder">;
type Target = RemoteFolder | SharedFolderPath;

export interface OpenProtonFolder {
  readonly identity: ProtonFolderIdentity;
  readonly list: Effect.Effect<HashSet.HashSet<string>, BackupError>;
  readonly trash: (names: HashSet.HashSet<ArchiveName>) => Effect.Effect<void, BackupError>;
}

const initialize = Effect.fn("ProtonDrive.initialize")(function* (
  cli: ProtonCli["Service"],
  destination: Folder,
) {
  if (destination.remoteFolder.startsWith("/shared-with-me/")) {
    yield* resolveSharedFolder(cli, destination.remoteFolder, true);
    return;
  }
  let parent = "/my-files";
  const names = destination.remoteFolder.slice(parent.length + 1);
  for (const name of names === "" ? [] : names.split("/")) {
    const folders = yield* cli.list(parent, "folder");
    if (!HashSet.has(folders, name)) {
      yield* cli.createFolder(parent, name);
    }
    parent = `${parent}/${name}`;
  }
});

// Recheck ancestors for checks and retention retries too; do not cache access.
const withFolder = Effect.fn("ProtonDrive.withFolder")(function* <A>(
  cli: ProtonCli["Service"],
  destination: Folder,
  operation: (folder: Target) => Effect.Effect<A, BackupError>,
) {
  const folder = destination.remoteFolder.startsWith("/shared-with-me/")
    ? yield* resolveSharedFolder(cli, destination.remoteFolder, false)
    : destination.remoteFolder;
  return yield* operation(folder);
});

const upload = Effect.fn("ProtonDrive.upload")(function* (
  cli: ProtonCli["Service"],
  folder: Target,
  archive: Archive,
) {
  yield* cli.upload(folder, [archive.file, archive.checksum]);
  const names = yield* cli.list(folder, "file");
  if (!HashSet.has(names, archive.name) || !HashSet.has(names, `${archive.name}.sha256`)) {
    return yield* BackupError.make({
      message: `Proton did not confirm archive pair ${archive.name}`,
    });
  }
});

const trashBatch = Effect.fn("ProtonDrive.trashBatch")(function* (
  cli: ProtonCli["Service"],
  folder: Target,
  pending: readonly string[],
) {
  if (pending.length > 0) {
    yield* cli.trash(Array.map(pending, (file) => `${folder}/${file}`));
  }
});

const trashOwn = Effect.fn("ProtonDrive.trashOwn")(function* (
  cli: ProtonCli["Service"],
  folder: Target,
  names: HashSet.HashSet<ArchiveName>,
) {
  if (HashSet.size(names) === 0) {
    return;
  }
  const existing = yield* cli.list(folder, "file");
  // Bound command arguments while sharing folder listings across the whole retention intent.
  for (const batch of Array.chunksOf(Array.fromIterable(names), 50)) {
    const pending = Array.filter(
      Array.flatMap(batch, (name) => [name, `${name}.sha256`]),
      (file) => HashSet.has(existing, file),
    );
    yield* trashBatch(cli, folder, pending);
  }
  const remaining = yield* cli.list(folder, "file");
  for (const name of names) {
    if (HashSet.has(remaining, name) || HashSet.has(remaining, `${name}.sha256`)) {
      return yield* BackupError.make({ message: `Proton did not confirm trashing ${name}` });
    }
  }
});

const trash = Effect.fn("ProtonDrive.trash")(
  (
    cli: ProtonCli["Service"],
    folder: Target,
    names: HashSet.HashSet<ArchiveName>,
  ): Effect.Effect<void, BackupError> =>
    HashSet.size(names) === 0
      ? Effect.void
      : folder.startsWith("/shared-with-me/")
        ? trashSharedFiles(cli, folder, names)
        : trashOwn(cli, folder, names),
);

export class ProtonDrive extends Context.Service<
  ProtonDrive,
  {
    readonly verify: Effect.Effect<void, BackupError>;
    readonly initialize: (destination: Folder) => Effect.Effect<void, BackupError>;
    readonly open: (destination: Folder) => Effect.Effect<OpenProtonFolder, BackupError>;
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
        open: (destination) =>
          withFolder(cli, destination, (folder) =>
            Effect.succeed({
              identity: protonFolderIdentity(folder),
              list: cli.list(folder, "file"),
              trash: (names) => trash(cli, folder, names),
            }),
          ),
        list: (destination) => withFolder(cli, destination, (folder) => cli.list(folder, "file")),
        upload: (destination, archive) =>
          withFolder(cli, destination, (folder) => upload(cli, folder, archive)),
        trash: (destination, names) =>
          withFolder(cli, destination, (folder) => trash(cli, folder, names)),
      });
    }),
  ).pipe(Layer.provide(ProtonCli.layer));
}
