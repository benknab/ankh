import { Array, Context, Effect, HashSet, Layer } from "effect";
import { type ArchiveName, BackupError, type Proton } from "#domain/model.ts";
import type { Archive } from "#domain/archive.ts";
import { ProtonCli } from "#clients/proton/cli.ts";

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

const trashPair = Effect.fn("ProtonDrive.trashPair")(function* (
  cli: ProtonCli["Service"],
  destination: Folder,
  name: ArchiveName,
) {
  const pair = [name, `${name}.sha256`];
  const existing = yield* cli.list(destination.remoteFolder, "file");
  const pending = Array.filter(pair, (file) => HashSet.has(existing, file));
  if (pending.length > 0) {
    yield* cli.trash(Array.map(pending, (file) => `${destination.remoteFolder}/${file}`));
  }
  const remaining = yield* cli.list(destination.remoteFolder, "file");
  if (Array.some(pair, (file) => HashSet.has(remaining, file))) {
    return yield* BackupError.make({ message: `Proton did not confirm trashing ${name}` });
  }
});

export class ProtonDrive extends Context.Service<
  ProtonDrive,
  {
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
        initialize: (destination) => initialize(cli, destination),
        list: (destination) => cli.list(destination.remoteFolder, "file"),
        upload: (destination, archive) => upload(cli, destination, archive),
        trash: (destination, names) =>
          Effect.forEach(names, (name) => trashPair(cli, destination, name), { discard: true }),
      });
    }),
  ).pipe(Layer.provide(ProtonCli.layer));
}
