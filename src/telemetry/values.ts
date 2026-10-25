import { Array, Cause, Predicate, Record, Redacted, Schema } from "effect";

const sensitive =
  /password|token|secret|authorization|cookie|credential|stdout|stderr|args|cause/iu;

export const isFields = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

const primitive = (input: unknown): Schema.Json => {
  if (Redacted.isRedacted(input)) {
    return "[redacted]";
  }
  if (Predicate.isError(input) || Cause.isCause(input)) {
    return "[error]";
  }
  if (Predicate.isString(input)) {
    return input.slice(0, 2048);
  }
  if (input === null || Predicate.isBoolean(input)) {
    return input;
  }
  return Predicate.isNumber(input) && Number.isFinite(input) ? input : "[unsupported]";
};

// Keep logged values JSON-safe and bounded; never inspect raw errors or secrets.
export const value = (input: unknown, depth = 0): Schema.Json => {
  if (
    !Predicate.isObject(input) ||
    Redacted.isRedacted(input) ||
    Predicate.isError(input) ||
    Cause.isCause(input)
  ) {
    return primitive(input);
  }
  if (depth >= 3) {
    return "[depth limit]";
  }
  if (Array.isArray(input)) {
    return Array.map(input.slice(0, 20), (item) => value(item, depth + 1));
  }
  return isFields(input)
    ? Record.fromEntries(
        Array.map(
          Record.toEntries(input).slice(0, 40),
          ([key, item]) =>
            [
              key.slice(0, 128),
              sensitive.test(key) ? "[redacted]" : value(item, depth + 1),
            ] as const,
        ),
      )
    : "[unsupported]";
};

export const fields = (
  input: Readonly<Record<string, unknown>>,
  depth = 0,
): Readonly<Record<string, Schema.Json>> =>
  Record.fromEntries(
    Array.map(
      Record.toEntries(input).slice(0, 40),
      ([key, item]) =>
        [key.slice(0, 128), sensitive.test(key) ? "[redacted]" : value(item, depth)] as const,
    ),
  );
