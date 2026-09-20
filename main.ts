import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { Live } from "./src/layers.ts";
import { AbsolutePath, Actions } from "./src/model.ts";
import { runJob } from "./src/runner.ts";
import { login } from "./src/auth.ts";
import { serve } from "./src/scheduler.ts";

const commands = Actions.map((action) =>
  Command.make(action, {
    job: Argument.String("job-file").pipe(
      Argument.withDefault("/job/backup.job.json"),
      Argument.withSchema(AbsolutePath),
    ),
  }, ({ job }) => runJob(job, action))
);

const cli = Command.make("backup-runner").pipe(
  Command.withSubcommands([
    ...commands,
    Command.make("proton-login", {}, () => login()),
    Command.make("schedule", {
      job: Argument.String("job-file").pipe(
        Argument.withDefault("/job/backup.job.json"),
        Argument.withSchema(AbsolutePath),
      ),
    }, ({ job }) => serve(job)),
  ]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(Live),
);

if (import.meta.main) {
  NodeRuntime.runMain(cli);
}
