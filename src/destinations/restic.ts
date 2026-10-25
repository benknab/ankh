import { Effect, Schema } from "effect";
import { Commands, type Options } from "../process/commands.ts";
import { type DestinationRequest, type Job, type Restic } from "../domain/model.ts";
import { Storage } from "../storage/storage.ts";

export const runRestic = Effect.fn("Restic.run")(function* (
  job: Job,
  destination: Restic,
  request: DestinationRequest,
) {
  const { action } = request;
  if (action === "retry") {
    return;
  }
  const { fs, path } = yield* Storage;
  const commands = yield* Commands;
  yield* Schema.decodeEffect(Schema.NonEmptyString)(
    (yield* fs.readFileString(destination.passwordFile)).trim(),
  );
  const options: Options = {
    output: "tail",
    env: {
      RESTIC_CACHE_DIR: "/tmp/restic-cache",
      RESTIC_REPOSITORY: destination.repository,
      RESTIC_PASSWORD_FILE: destination.passwordFile,
    },
  };
  const run = (args: readonly string[]) =>
    commands.run("restic", args, options).pipe(Effect.tap(Effect.logInfo));
  if (action === "init") {
    if (!(yield* fs.exists(path.join(destination.repository, "config")))) {
      yield* run(["init"]);
    } else {
      yield* run(["snapshots", "--json"]);
    }
  } else if (request.action === "backup") {
    const selection = ["--host", job.host, "--tag", `job:${job.name}`];
    yield* run(["backup", request.stage, ...selection]);
    yield* run([
      "forget",
      ...selection,
      "--keep-daily",
      String(job.retention.daily),
      "--keep-weekly",
      String(job.retention.weekly),
      "--keep-monthly",
      String(job.retention.monthly),
      "--keep-yearly",
      String(job.retention.yearly),
      "--prune",
    ]);
  } else {
    yield* run(action === "check-read-data" ? ["check", "--read-data"] : ["check"]);
  }
});
