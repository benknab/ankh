import { Array, Effect, Option, String } from "effect";
import { type Archive, archiveTime } from "#domain/archive.ts";
import { absolutePath, archiveFileName, type Job, type Proton } from "#domain/model.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

const retire = Effect.fn("Outbox.retire")(function* (job: Job, destination: Proton, entry: string) {
  const { fs, path } = yield* Storage;
  const legacy = entry.startsWith(".ack-");
  const name = legacy ? entry.slice(5) : `${entry.slice(9)}.tar.zst`;
  if (Option.isSome(archiveTime(job.name, name))) {
    if (legacy) {
      yield* fs.remove(path.join(destination.outbox, name), { force: true });
      yield* fs.remove(path.join(destination.outbox, `${name}.sha256`), { force: true });
    }
    yield* fs.remove(path.join(destination.outbox, entry), { recursive: true, force: true });
  }
});

const readEntry = Effect.fn("Outbox.readEntry")(function* (
  job: Job,
  destination: Proton,
  entry: string,
) {
  const { path } = yield* Storage;
  const legacy = entry.endsWith(".tar.zst");
  const name = legacy ? entry : `${entry}.tar.zst`;
  const directory = absolutePath(
    legacy ? destination.outbox : path.join(destination.outbox, entry),
  );
  return Option.map(archiveTime(job.name, name), (): Archive => ({
    name: archiveFileName(name),
    directory,
    legacy,
    file: absolutePath(path.join(directory, name)),
    checksum: absolutePath(path.join(directory, `${name}.sha256`)),
  }));
});

export const list = Effect.fn("Outbox.list")(function* (job: Job, destination: Proton) {
  const { fs } = yield* Storage;
  yield* privateDirectory(destination.outbox);
  yield* Effect.forEach(
    yield* fs.readDirectory(destination.outbox),
    (entry) =>
      entry.startsWith(".retired-") || entry.startsWith(".ack-")
        ? retire(job, destination, entry)
        : Effect.void,
    { discard: true },
  );
  const entries = Array.sort(
    Array.dedupe(
      Array.map(yield* fs.readDirectory(destination.outbox), (entry) =>
        entry.endsWith(".tar.zst.sha256") ? entry.slice(0, -7) : entry,
      ),
    ),
    String.Order,
  );
  return Array.getSomes(
    yield* Effect.forEach(entries, (entry) => readEntry(job, destination, entry)),
  );
});

export const acknowledge = Effect.fn("Outbox.acknowledge")(function* (archive: Archive) {
  const { fs, path } = yield* Storage;
  if (archive.legacy) {
    const marker = path.join(archive.directory, `.ack-${archive.name}`);
    yield* fs.makeDirectory(marker, { recursive: true, mode: 0o700 });
    yield* fs.remove(archive.file, { force: true });
    yield* fs.remove(archive.checksum, { force: true });
    yield* fs.remove(marker, { recursive: true, force: true });
  } else {
    const retired = path.join(
      path.dirname(archive.directory),
      `.retired-${path.basename(archive.directory)}`,
    );
    yield* fs.rename(archive.directory, retired);
    yield* fs.remove(retired, { recursive: true, force: true });
  }
});
