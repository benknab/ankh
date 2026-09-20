import { Brand, Schema } from "effect";

export class BackupError
  extends Schema.TaggedError<BackupError>()("BackupError", {
    message: Schema.String,
  }) {}

export const JobName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
).pipe(Schema.brand("JobName"));
export type JobName = typeof JobName.Type;
export const AbsolutePath = Schema.String.check(
  Schema.isPattern(/^\/(?!$)(?!.*(?:^|\/)\.\.?($|\/))[^\0]+$/),
).pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;
export const absolutePath = Brand.nominal<AbsolutePath>();
export const RemoteFolder = Schema.String.check(
  Schema.isPattern(/^\/my-files\/(?!.*(?:^|\/)\.\.?($|\/))[^\\\0]+[^\/]$/),
).pipe(Schema.brand("RemoteFolder"));
export type RemoteFolder = typeof RemoteFolder.Type;
export const ArchiveName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*-\d{8}T\d{9}Z\.tar\.zst$/),
).pipe(Schema.brand("ArchiveName"));
export type ArchiveName = typeof ArchiveName.Type;
export const archiveFileName = Brand.nominal<ArchiveName>();
const FileName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
);
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Retention = Schema.Struct({
  daily: Count,
  weekly: Count,
  monthly: Count,
  yearly: Count,
}).check(
  Schema.makeFilter((r) => r.daily + r.weekly + r.monthly + r.yearly > 0),
);
export type Retention = typeof Retention.Type;

export const Sqlite = Schema.Struct({
  type: Schema.Literal("sqlite"),
  path: AbsolutePath,
  output: FileName,
});
export const Gitea = Schema.Struct({
  type: Schema.Literal("gitea-git"),
  apiUrl: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/)),
  tokenFile: AbsolutePath,
});
export const Restic = Schema.Struct({
  type: Schema.Literal("restic"),
  repository: AbsolutePath,
  passwordFile: AbsolutePath,
});
export type Restic = typeof Restic.Type;
export const Proton = Schema.Struct({
  type: Schema.Literal("proton-drive"),
  remoteFolder: RemoteFolder,
  outbox: AbsolutePath,
});
export type Proton = typeof Proton.Type;
export const Destination = Schema.Union([Restic, Proton]);
export type Destination = typeof Destination.Type;

export const Job = Schema.Struct({
  version: Schema.Literal(1),
  name: JobName,
  host: Schema.NonEmptyString,
  source: Schema.Union([Sqlite, Gitea]),
  backupDrive: Schema.Struct({
    sentinelFile: AbsolutePath,
    driveSerial: Schema.NonEmptyString,
    filesystemUuid: Schema.NonEmptyString,
  }),
  destinations: Schema.Array(Destination).check(
    Schema.isMinLength(1),
    Schema.makeFilter((ds) =>
      new Set(ds.map((d) => d.type)).size === ds.length
    ),
  ),
  retention: Retention,
});
export type Job = typeof Job.Type;
export const JobJson = Schema.fromJsonString(Job);
export const Actions = [
  "init",
  "backup",
  "retry",
  "check",
  "check-read-data",
] as const;
export type Action = typeof Actions[number];
export type DestinationRequest =
  | { readonly action: "backup"; readonly stage: AbsolutePath }
  | { readonly action: Exclude<Action, "backup"> };
