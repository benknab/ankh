import { Brand, Cron, HashSet, Result, Schema } from "effect";

export class BackupError extends Schema.TaggedError<
  BackupError,
  { readonly brand: unique symbol }
>()("BackupError", {
  message: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const backupError =
  (operation: string) =>
  (cause: unknown): BackupError =>
    cause instanceof BackupError
      ? cause
      : new BackupError({ message: `${operation} failed`, operation, cause });

export const JobName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/)).pipe(
  Schema.brand("JobName"),
);
export type JobName = typeof JobName.Type;
export const AbsolutePath = Schema.String.check(
  Schema.isPattern(/^\/(?!$)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\/\/)(?!.*\/$)[^\0]+$/),
).pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;
export const absolutePath = Brand.nominal<AbsolutePath>();
export const RemoteFolder = Schema.String.check(
  Schema.isPattern(/^\/my-files\/(?!.*(?:^|\/)\.\.?($|\/))[^/\\\0]+(?:\/[^/\\\0]+)*$/),
).pipe(Schema.brand("RemoteFolder"));
export type RemoteFolder = typeof RemoteFolder.Type;
export const ArchiveName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*-\d{8}T\d{9}Z\.tar\.zst$/),
).pipe(Schema.brand("ArchiveName"));
export type ArchiveName = typeof ArchiveName.Type;
export const archiveFileName = Brand.nominal<ArchiveName>();
const FileName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Retention = Schema.Struct({
  daily: Count,
  weekly: Count,
  monthly: Count,
  yearly: Count,
}).check(Schema.makeFilter((r) => r.daily + r.weekly + r.monthly + r.yearly > 0));
export type Retention = typeof Retention.Type;

export const Sqlite = Schema.Struct({
  type: Schema.Literal("sqlite"),
  path: AbsolutePath,
  output: FileName,
});
export const Gitea = Schema.Struct({
  type: Schema.Literal("gitea-git"),
  apiUrl: Schema.URLFromString.check(
    Schema.makeFilter(
      (url) =>
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      { message: "Use an HTTP(S) base URL without credentials, query, or fragment" },
    ),
  ),
  tokenFile: AbsolutePath,
});
const PostgresName = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_-]*$/)).pipe(
  Schema.brand("PostgresName"),
);
export const Postgres = Schema.Struct({
  type: Schema.Literal("postgres"),
  hostname: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/)),
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  database: PostgresName,
  username: PostgresName,
  passwordFile: AbsolutePath,
  output: FileName,
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

export const JobSchedule = Schema.Struct({
  cron: Schema.String,
  timeZone: Schema.String,
}).check(
  Schema.makeFilter((schedule) => Result.isSuccess(Cron.parse(schedule.cron, schedule.timeZone)), {
    message: "Invalid cron expression or time zone",
  }),
);
export type JobSchedule = typeof JobSchedule.Type;
export const defaultSchedule: JobSchedule = { cron: "30 3 * * *", timeZone: "UTC" };

const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export const Job = Schema.Struct({
  version: Schema.Literal(1),
  name: JobName,
  host: Schema.NonEmptyString,
  source: Schema.Union([Sqlite, Gitea, Postgres]),
  backupDrive: Schema.Struct({
    sentinelFile: AbsolutePath,
    driveSerial: Schema.NonEmptyString,
    filesystemUuid: Schema.NonEmptyString,
  }),
  destinations: Schema.Array(Destination).check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (ds) => HashSet.size(HashSet.fromIterable(ds.map((d) => d.type))) === ds.length,
    ),
  ),
  retention: Retention,
  schedule: Schema.optionalKey(JobSchedule),
}).check(
  Schema.makeFilter(
    (job) => {
      const inputs = [
        job.backupDrive.sentinelFile,
        job.source.type === "sqlite"
          ? job.source.path
          : job.source.type === "postgres"
            ? job.source.passwordFile
            : job.source.tokenFile,
        ...job.destinations.flatMap((d) => (d.type === "restic" ? [d.passwordFile] : [])),
      ];
      const outputs = job.destinations.map((d) => (d.type === "restic" ? d.repository : d.outbox));
      return (
        [...inputs, ...outputs].every((p) => !overlaps(p, "/staging") && !overlaps(p, "/proton")) &&
        outputs.every(
          (output, index) =>
            inputs.every((input) => !overlaps(output, input)) &&
            outputs.slice(index + 1).every((other) => !overlaps(output, other)),
        )
      );
    },
    {
      message: "Source, secrets, sentinel, and destinations must not overlap writable state paths",
    },
  ),
);
export type Job = typeof Job.Type;
export const JobJson = Schema.fromJsonString(Job);
export const Actions = ["init", "backup", "retry", "check", "check-read-data"] as const;
export type Action = (typeof Actions)[number];
export type DestinationRequest =
  | { readonly action: "backup"; readonly stage: AbsolutePath }
  | { readonly action: Exclude<Action, "backup"> };
