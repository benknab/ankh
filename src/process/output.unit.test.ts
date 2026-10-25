import { expect, it } from "@effect/vitest";
import { Array, Effect, Stream } from "effect";
import { capture } from "#/process/output.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

it.effect("capture preserves UTF-8 across byte boundaries and can be rerun", () =>
  Effect.gen(function* () {
    const bytes = encode(" start 🦊 café\n");
    const output = capture(
      Stream.fromIterable(Array.map(Array.fromIterable(bytes), (byte) => new Uint8Array([byte]))),
      false,
    );
    expect(yield* output).toEqual({ text: " start 🦊 café\n", overflow: false });
    expect(yield* output).toEqual({ text: " start 🦊 café\n", overflow: false });
  }),
);

it.effect("capture retains the exact limit and drains every chunk after overflow", () =>
  Effect.gen(function* () {
    const chunk = encode("x".repeat(4096));
    const full = Stream.fromIterable(Array.makeBy(4096, () => chunk));
    const exact = yield* capture(full, false);
    expect(exact.text).toBe("x".repeat(16 * 1024 * 1024));
    expect(exact.overflow).toBe(false);
    let drained = 0;
    const overflow = Stream.fromIterable(Array.makeBy(100, () => encode("end"))).pipe(
      Stream.tap(() =>
        Effect.sync(() => {
          drained += 1;
        }),
      ),
    );
    const result = yield* capture(Stream.concat(full, overflow), false);
    expect(result).toEqual({ text: exact.text, overflow: true });
    expect(drained).toBe(100);
  }),
);

it.effect("diagnostic capture keeps the exact suffix across small and oversized chunks", () =>
  Effect.gen(function* () {
    const chunks = [
      "a".repeat(40_000),
      "b".repeat(40_000),
      "c".repeat(100_000),
      ...Array.makeBy(2000, () => "tail"),
    ];
    const result = yield* capture(Stream.fromIterable(Array.map(chunks, encode)), true);
    expect(result).toEqual({ text: Array.join(chunks, "").slice(-64 * 1024), overflow: false });
    expect(yield* capture(Stream.empty, true)).toEqual({ text: "", overflow: false });
  }),
);
