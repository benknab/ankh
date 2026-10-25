import { Cause, Exit, Option, Schema } from "effect";
import { BackupError, type Action, type JobName } from "#domain/model.ts";
import type { Messages } from "#telemetry/messages.ts";

export type Operation = Action | "validate" | "proton-login";
export type Step =
  | "configuration"
  | "source"
  | "restic"
  | "proton-drive"
  | "process"
  | "drive"
  | "lock"
  | "cleanup"
  | "archive"
  | "upload"
  | "retention";
export type Status = "success" | "failure" | "interrupted";

export interface StepSummary {
  readonly attempts: number;
  readonly failures: number;
  readonly interruptions: number;
  readonly durationMs: number;
}

export interface Details {
  readonly job?: JobName;
  readonly source?: "sqlite" | "postgres" | "gitea-git";
  readonly steps: Partial<Readonly<Record<Step, StepSummary>>>;
}

export interface Completion extends Details, Messages {
  readonly event: "execution.completed";
  readonly runId: string;
  readonly operation: Operation;
  readonly status: Status;
  readonly durationMs: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly failure?: {
    readonly kind: "backup" | "failure" | "defect" | "interrupted";
    readonly exitCode?: number;
  };
}

export const status = <A, E>(exit: Exit.Exit<A, E>): Status =>
  Exit.isSuccess(exit)
    ? "success"
    : Cause.hasInterruptsOnly(exit.cause)
      ? "interrupted"
      : "failure";

export const failure = <A, E>(exit: Exit.Exit<A, E>): Pick<Completion, "failure"> => {
  if (Exit.isSuccess(exit)) {
    return {};
  }
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isSome(error) && Schema.is(BackupError)(error.value)) {
    return {
      failure: {
        kind: "backup",
        ...(error.value.exitCode === undefined ? {} : { exitCode: error.value.exitCode }),
      },
    };
  }
  return {
    failure: {
      kind: Cause.hasDies(exit.cause)
        ? "defect"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "interrupted"
          : "failure",
    },
  };
};
