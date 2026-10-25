import {
  Array,
  Cause,
  Context,
  Exit,
  Logger,
  type LogLevel,
  MutableRef,
  Predicate,
  Record,
  Redacted,
  References,
  type Schema,
} from "effect";
import { fields, isFields, value } from "#telemetry/values.ts";
import { type Completion, failure } from "#telemetry/event.ts";

export interface Message {
  readonly level: LogLevel.LogLevel;
  readonly text: string;
  readonly annotations: Readonly<Record<string, Schema.Json>>;
  readonly failure?: Completion["failure"];
}

export interface Messages {
  readonly messages: readonly Message[];
  readonly data: Readonly<Record<string, Schema.Json>>;
  readonly droppedMessages: number;
  readonly droppedFields: number;
}

export const ProgressLog = Context.Reference<boolean>(
  "backup-runner/telemetry/messages/ProgressLog",
  { defaultValue: () => false },
);

export const make = (): MutableRef.MutableRef<Messages> =>
  MutableRef.make({ messages: [], data: {}, droppedMessages: 0, droppedFields: 0 });

const append = (state: Messages, message: Message): Messages =>
  state.messages.length < 100
    ? { ...state, messages: [...state.messages, message] }
    : { ...state, droppedMessages: state.droppedMessages + 1 };

const merge = (state: Messages, input: Readonly<Record<string, unknown>>): Messages =>
  Array.reduce(
    Record.toEntries(fields(input)),
    { ...state, droppedFields: state.droppedFields + Math.max(0, Record.size(input) - 40) },
    (current, [key, item]) =>
      Record.has(current.data, key) || Record.size(current.data) < 100
        ? { ...current, data: { ...current.data, [key]: item } }
        : { ...current, droppedFields: current.droppedFields + 1 },
  );

const collect = (state: Messages, options: Logger.Options<unknown>): Messages =>
  Array.reduce(Array.ensure(options.message), state, (current, item) =>
    !options.fiber.getRef(ProgressLog) &&
    isFields(item) &&
    !Predicate.isError(item) &&
    !Cause.isCause(item) &&
    !Redacted.isRedacted(item)
      ? merge(current, item)
      : append(current, {
          level: options.logLevel,
          text: Predicate.isString(item) ? item.slice(0, 2048) : JSON.stringify(value(item)),
          annotations: fields(options.fiber.getRef(References.CurrentLogAnnotations)),
        }),
  );

// Logger callbacks are synchronous. MutableRef keeps updates local to this run
// without starting an Effect runtime inside the logger.
export const collector = (buffer: MutableRef.MutableRef<Messages>): Logger.Logger<unknown, void> =>
  Logger.make((options) => {
    MutableRef.update(buffer, (state) => collect(state, options));
    if (options.cause.reasons.length > 0) {
      MutableRef.update(buffer, (state) =>
        append(state, {
          level: options.logLevel,
          text: "Failure recorded",
          annotations: fields(options.fiber.getRef(References.CurrentLogAnnotations)),
          ...failure(Exit.failCause(options.cause)),
        }),
      );
    }
  });
