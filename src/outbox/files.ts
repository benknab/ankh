import { Array, Effect, Option, String } from "effect";
import { type Archive, archiveTime } from "#domain/archive.ts";
import { absolutePath, archiveFileName, type Job, type Proton } from "#domain/model.ts";
import { privateDirectory, Storage } from "#storage/storage.ts";

const retire = Effect.fn("Outbox.retire")(function* (job: Job, destination: Proton, entry: string) {
  const { fs, path } = yield* Storage;
  const name = `${entry.slice(9)}.tar.zst`;
  if (Option.isSome(archiveTime(job.name, name))) {
    yield* fs.remove(path.join(destination.outbox, entry), { recursive: true, force: true });
  }
});

const readEntry = Effect.fn("Outbox.readEntry")(function* (
  job: Job,
  destination: Proton,
  entry: string,
) {
  const { path } = yield* Storage;
  const name = `${entry}.tar.zst`;
  const directory = absolutePath(path.join(destination.outbox, entry));
  return Option.map(archiveTime(job.name, name), (): Archive => ({
    name: archiveFileName(name),
    directory,
    file: absolutePath(path.join(directory, name)),
    checksum: absolutePath(path.join(directory, `${name}.sha256`)),
  }));
});

export const list = Effect.fn("Outbox.list")(function* (job: Job, destination: Proton) {
  const { fs } = yield* Storage;
  yield* privateDirectory(destination.outbox);
  yield* Effect.forEach(
    yield* fs.readDirectory(destination.outbox),
    (entry) => (entry.startsWith(".retired-") ? retire(job, destination, entry) : Effect.void),
    { discard: true },
  );
  const entries = Array.sort(yield* fs.readDirectory(destination.outbox), String.Order);
  return Array.getSomes(
    yield* Effect.forEach(entries, (entry) => readEntry(job, destination, entry)),
  );
});

export const acknowledge = Effect.fn("Outbox.acknowledge")(function* (archive: Archive) {
  const { fs, path } = yield* Storage;
  const retired = path.join(
    path.dirname(archive.directory),
    `.retired-${path.basename(archive.directory)}`,
  );
  yield* fs.rename(archive.directory, retired);
  yield* fs.remove(retired, { recursive: true, force: true });
});
