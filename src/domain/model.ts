import { Array, Brand, Cron, Effect, HashSet, Redacted, Result, Schema } from "effect";

export class BackupError extends Schema.TaggedError<
  BackupError,
  { readonly brand: unique symbol }
>()("BackupError", {
  message: Schema.String,
  operation: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Int),
  cause: Schema.optionalKey(Schema.Redacted(Schema.Unknown, { disallowJsonEncode: true })),
}) {}

export const backupError =
  (operation: string) =>
  (cause: unknown): BackupError =>
    Schema.is(BackupError)(cause)
      ? cause
      : BackupError.make({
          message: `${operation} failed`,
          operation,
          cause: Redacted.make(cause),
        });

export const JobName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u)).pipe(
  Schema.brand("JobName"),
);
export type JobName = typeof JobName.Type;
export const AbsolutePath = Schema.String.check(
  Schema.isPattern(/^\/(?!$)(?!.*(?:^|\/)\.\.?($|\/))(?!.*\/\/)(?!.*\/$)[^\0]+$/u),
).pipe(Schema.brand("AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;
export const absolutePath = Brand.nominal<AbsolutePath>();
export const driveLockPath = (sentinel: AbsolutePath): AbsolutePath =>
  absolutePath(`${sentinel.slice(0, sentinel.lastIndexOf("/"))}/.runner-lock`);
export const RemoteFolder = Schema.String.check(
  Schema.isPattern(/^\/my-files\/(?!.*(?:^|\/)\.\.?($|\/))[^/\\\0]+(?:\/[^/\\\0]+)*$/u),
).pipe(Schema.brand("RemoteFolder"));
export type RemoteFolder = typeof RemoteFolder.Type;
export const ArchiveName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*-\d{8}T\d{9}Z\.tar\.zst$/u),
).pipe(Schema.brand("ArchiveName"));
export type ArchiveName = typeof ArchiveName.Type;
export const archiveFileName = Brand.nominal<ArchiveName>();
const FileName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u));
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
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "",
      { message: "Use an HTTP(S) base URL without credentials, query, or fragment" },
    ),
  ),
  tokenFile: AbsolutePath,
});
const PostgresName = Schema.String.check(Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_-]*$/u)).pipe(
  Schema.brand("PostgresName"),
);
export const Postgres = Schema.Struct({
  type: Schema.Literal("postgres"),
  hostname: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/u)),
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
  timeZone: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("UTC"))),
}).check(
  Schema.makeFilter(
    (schedule) => {
      const parsed = Cron.parse(schedule.cron, schedule.timeZone);
      return (
        Result.isSuccess(parsed) &&
        Result.isSuccess(Result.try(() => Cron.next(parsed.success, "2000-01-01T00:00:00Z")))
      );
    },
    { message: "Invalid cron expression, time zone, or calendar date" },
  ),
);
export type JobSchedule = typeof JobSchedule.Type;

const overlaps = (a: string, b: string): boolean =>
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
      (ds) => HashSet.size(HashSet.fromIterable(Array.map(ds, (d) => d.type))) === ds.length,
    ),
  ),
  retention: Retention,
  schedule: JobSchedule,
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
        ...Array.flatMap(job.destinations, (d) => (d.type === "restic" ? [d.passwordFile] : [])),
      ];
      const outputs = Array.map(job.destinations, (d) =>
        d.type === "restic" ? d.repository : d.outbox,
      );
      return (
        Array.every(
          [...inputs, ...outputs],
          (p) =>
            !overlaps(p, "/staging") &&
            !overlaps(p, "/proton") &&
            !overlaps(p, driveLockPath(job.backupDrive.sentinelFile)),
        ) &&
        Array.every(
          outputs,
          (output, index) =>
            Array.every(inputs, (input) => !overlaps(output, input)) &&
            Array.every(outputs.slice(index + 1), (other) => !overlaps(output, other)),
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
