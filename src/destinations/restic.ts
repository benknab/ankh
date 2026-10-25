import { Effect } from "effect";
import { ResticClient } from "#clients/restic.ts";
import type { DestinationAdapter } from "#domain/adapters.ts";
import type { DestinationRequest, Job, Restic } from "#domain/model.ts";

export const resticAdapter: DestinationAdapter<Restic, ResticClient> = {
  run: Effect.fn("Restic.run")(function* (
    job: Job,
    destination: Restic,
    request: DestinationRequest,
  ) {
    const client = yield* ResticClient;
    switch (request.action) {
      case "retry":
        return;
      case "init":
        return yield* client.initialize(destination);
      case "backup":
        return yield* client.backup(destination, {
          stage: request.stage,
          host: job.host,
          tag: `job:${job.name}`,
          retention: job.retention,
        });
      case "check":
        return yield* client.check(destination, false);
      case "check-read-data":
        return yield* client.check(destination, true);
    }
  }),
};
