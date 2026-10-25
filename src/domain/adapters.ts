import type { Effect } from "effect";
import type {
  AbsolutePath,
  BackupError,
  Destination,
  DestinationRequest,
  Job,
} from "#/domain/model.ts";

export interface SourceAdapter<C, R> {
  readonly stage: (
    source: C,
    directory: AbsolutePath,
  ) => Effect.Effect<AbsolutePath, BackupError, R>;
}

export interface DestinationAdapter<C extends Destination, R> {
  readonly run: (
    job: Job,
    destination: C,
    request: DestinationRequest,
  ) => Effect.Effect<void, BackupError, R>;
}
