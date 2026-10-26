import { Array, Brand, Effect, HashMap, HashSet, Option } from "effect";
import { type ArchiveName, BackupError, type RemoteFolder } from "#/domain/model.ts";
import type { ProtonCli } from "#/clients/proton/cli.ts";

export type SharedFolderPath = string & Brand.Brand<"SharedFolderPath">;
const sharedFolderPath = Brand.nominal<SharedFolderPath>();

const findFolder = Effect.fn("ProtonDrive.findSharedFolder")(function* (
  cli: ProtonCli["Service"],
  parent: string,
  { name, createMissing }: { readonly name: string; readonly createMissing: boolean },
) {
  let node = HashMap.get(yield* cli.sharedNodes(parent), name);
  if (Option.isNone(node) && createMissing) {
    yield* cli.createFolder(parent, name);
    node = HashMap.get(yield* cli.sharedNodes(parent), name);
  }
  if (Option.isNone(node) || node.value.type !== "folder") {
    return yield* BackupError.make({
      message:
        parent === "/shared-with-me"
          ? "Proton shared folder is unavailable; accept its invitation with the backup account and check remoteFolder and Editor access"
          : "Proton destination folder is unavailable; check remoteFolder and run init",
    });
  }
  return node.value.uid;
});

export const resolveSharedFolder = Effect.fn("ProtonDrive.resolveSharedFolder")(function* (
  cli: ProtonCli["Service"],
  folder: RemoteFolder,
  createMissing: boolean,
) {
  const root = Array.join(folder.split("/").slice(0, 3), "/");
  const uid = yield* findFolder(cli, "/shared-with-me", {
    name: root.slice("/shared-with-me/".length),
    createMissing: false,
  });
  // CLI 0.8.0 requires a root name, then supports UID segments below it. Pin the
  // root too: even if another same-named share appears, it cannot redirect us.
  let parent = `${root}/${uid}`;
  const names = folder.slice(root.length + 1);
  for (const name of names === "" ? [] : names.split("/")) {
    const child = yield* findFolder(cli, parent, { name, createMissing });
    parent = `${parent}/${child}`;
  }
  return sharedFolderPath(parent);
});

export const trashSharedFiles = Effect.fn("ProtonDrive.trashSharedFiles")(function* (
  cli: ProtonCli["Service"],
  folder: SharedFolderPath | RemoteFolder,
  names: HashSet.HashSet<ArchiveName>,
) {
  const entries = yield* cli.sharedNodes(folder);
  const files = Array.flatMap(Array.fromIterable(names), (name) => [name, `${name}.sha256`]);
  const targets = HashSet.fromIterable(
    Array.getSomes(
      Array.map(files, (name) =>
        HashMap.get(entries, name).pipe(
          Option.filter((node) => node.type === "file"),
          Option.map((node) => node.uid),
        ),
      ),
    ),
  );
  // Bind individual files too: a concurrent rename must not trash an unrelated
  // file or folder that takes the archive's old name after the listing.
  for (const batch of Array.chunksOf(Array.fromIterable(targets), 100)) {
    yield* cli.trash(Array.map(batch, (uid) => `${folder}/${uid}`));
  }
  const remaining = yield* cli.sharedNodes(folder);
  if (
    Array.some(Array.fromIterable(HashMap.values(remaining)), (node) =>
      HashSet.has(targets, node.uid),
    )
  ) {
    return yield* BackupError.make({
      message: "Proton did not confirm trashing shared archive files",
    });
  }
});
