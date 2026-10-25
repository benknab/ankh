import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";
import { Live } from "#app/layers.ts";
import { AbsolutePath, Actions, BackupError } from "#domain/model.ts";
import { runJob } from "#app/runner.ts";
import { login } from "#clients/proton/auth.ts";
import { serve } from "#app/scheduler.ts";
import { loadJob } from "#storage/storage.ts";
import metadata from "#package" with { type: "json" };

const jobArgument = Argument.String("job-file").pipe(
  Argument.withDefault("/job/backup.job.json"),
  Argument.withSchema(AbsolutePath),
);
const descriptions = {
  init: "Initialize the configured backup destinations",
  backup: "Stage the source and back up to every destination",
  retry: "Upload pending archives without reading the source",
  check: "Check repository metadata and archive pairs",
  "check-read-data": "Read and verify Restic data and check Proton pair names",
};

const commands = Actions.map((action) =>
  Command.make(
    action,
    {
      job: jobArgument,
    },
    ({ job }) => runJob(job, action),
  ).pipe(Command.withDescription(descriptions[action])),
);

const cli = Command.make("backup-runner").pipe(
  Command.withSubcommands([
    ...commands,
    Command.make("validate", { job: jobArgument }, ({ job }) =>
      loadJob(job).pipe(Effect.tap(() => Effect.logInfo("Job configuration is valid"))),
    ).pipe(
      Command.withDescription(
        "Validate configuration without accessing backup mounts or credentials",
      ),
    ),
    Command.make("proton-login", {}, () => login()).pipe(
      Command.withDescription("Log in interactively and persist Proton credentials"),
    ),
    Command.make(
      "schedule",
      {
        job: jobArgument,
      },
      ({ job }) => serve(job),
    ).pipe(Command.withDescription("Wait for scheduled backups; restart after schedule changes")),
  ]),
  Command.run({ version: metadata.version }),
  Effect.provide(Live),
  Effect.tapError((error) =>
    error instanceof BackupError ? Console.error(error.message) : Console.error(String(error)),
  ),
);

if (import.meta.main) {
  NodeRuntime.runMain(cli, { disableErrorReporting: true });
}
