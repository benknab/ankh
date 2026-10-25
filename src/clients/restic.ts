import { Context, Effect, Layer, Schema } from "effect";
import {
  type AbsolutePath,
  backupError,
  type BackupError,
  type Restic,
  type Retention,
} from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { Storage } from "#storage/storage.ts";

interface SnapshotRequest {
  readonly stage: AbsolutePath;
  readonly host: string;
  readonly tag: string;
  readonly retention: Retention;
}

const run = Effect.fn("ResticClient.run")(
  function* (destination: Restic, args: readonly string[]) {
    const { fs } = yield* Storage;
    const commands = yield* Commands;
    yield* Schema.decodeEffect(Schema.NonEmptyString)(
      (yield* fs.readFileString(destination.passwordFile)).trim(),
    );
    yield* commands.run("restic", args, {
      output: "tail",
      env: {
        RESTIC_CACHE_DIR: "/tmp/restic-cache",
        RESTIC_REPOSITORY: destination.repository,
        RESTIC_PASSWORD_FILE: destination.passwordFile,
      },
    });
  },
  Effect.mapError(backupError("Restic")),
);

const initialize = Effect.fn("ResticClient.initialize")(
  function* (destination: Restic) {
    const { fs, path } = yield* Storage;
    const initialized = yield* fs.exists(path.join(destination.repository, "config"));
    yield* run(destination, initialized ? ["snapshots", "--json"] : ["init"]);
  },
  Effect.mapError(backupError("Restic initialization")),
);

const backup = Effect.fn("ResticClient.backup")(function* (
  destination: Restic,
  snapshot: SnapshotRequest,
) {
  const selection = ["--host", snapshot.host, "--tag", snapshot.tag];
  const { retention } = snapshot;
  yield* run(destination, ["backup", snapshot.stage, ...selection]);
  yield* run(destination, [
    "forget",
    ...selection,
    "--keep-daily",
    String(retention.daily),
    "--keep-weekly",
    String(retention.weekly),
    "--keep-monthly",
    String(retention.monthly),
    "--keep-yearly",
    String(retention.yearly),
    "--prune",
  ]);
});

export class ResticClient extends Context.Service<
  ResticClient,
  {
    readonly initialize: (destination: Restic) => Effect.Effect<void, BackupError>;
    readonly backup: (
      destination: Restic,
      snapshot: SnapshotRequest,
    ) => Effect.Effect<void, BackupError>;
    readonly check: (destination: Restic, readData: boolean) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/clients/restic/ResticClient") {
  public static readonly layer = Layer.effect(
    ResticClient,
    Effect.gen(function* () {
      const context = (yield* Effect.context<Storage | Commands>()).pipe(
        Context.pick(Storage, Commands),
      );
      return ResticClient.of({
        initialize: (destination) => initialize(destination).pipe(Effect.provide(context)),
        backup: (destination, snapshot) =>
          backup(destination, snapshot).pipe(Effect.provide(context)),
        check: (destination, readData) =>
          run(destination, readData ? ["check", "--read-data"] : ["check"]).pipe(
            Effect.provide(context),
          ),
      });
    }),
  );
}
