import { DateTime, Option, Schema } from "effect";
import { type AbsolutePath, archiveFileName, ArchiveName, type JobName } from "#domain/model.ts";

export type Archive = {
  readonly name: ArchiveName;
  readonly file: AbsolutePath;
  readonly checksum: AbsolutePath;
  readonly directory: AbsolutePath;
  readonly legacy: boolean;
};

export const archiveName = (job: JobName, time: DateTime.Utc): ArchiveName =>
  archiveFileName(`${job}-${DateTime.formatIso(time).replace(/[-:.]/g, "")}.tar.zst`);

export const archiveTime = (job: JobName, name: string): Option.Option<DateTime.Utc> => {
  if (Option.isNone(Schema.decodeOption(ArchiveName)(name))) {
    return Option.none();
  }
  const match = name.match(
    new RegExp(`^${job}-(\\d{4})(\\d{2})(\\d{2})T(\\d{2})(\\d{2})(\\d{2})(\\d{3})Z\\.tar\\.zst$`),
  );
  if (!match) {
    return Option.none();
  }
  return DateTime.make(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`,
  ).pipe(Option.filter((time) => archiveName(job, time) === name));
};
