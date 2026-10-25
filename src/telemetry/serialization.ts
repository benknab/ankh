import { Array, Effect, Layer } from "effect";
import { OtlpSerialization, type OtlpTracer } from "effect/observability";

type Span = OtlpTracer.ScopeSpan["spans"][number];

// Effect adds raw failure messages and stacks to spans. Keep the failure status,
// but omit generated exception details before the standard OTLP JSON encoder.
const safeSpan = (span: Span): Span => ({
  ...span,
  status: { code: span.status.code },
  events: Array.map(span.events, (event) =>
    event.name === "exception" ? { ...event, attributes: [] } : event,
  ),
});

export const Serialization = Layer.effect(
  OtlpSerialization.OtlpSerialization,
  Effect.gen(function* () {
    const encoder = yield* OtlpSerialization.OtlpSerialization;
    return OtlpSerialization.OtlpSerialization.of({
      ...encoder,
      traces: (data) =>
        encoder.traces({
          ...data,
          resourceSpans: Array.map(data.resourceSpans, (resource) => ({
            ...resource,
            scopeSpans: Array.map(resource.scopeSpans, (scope) => ({
              ...scope,
              spans: Array.map(scope.spans, safeSpan),
            })),
          })),
        }),
    });
  }),
).pipe(Layer.provide(OtlpSerialization.layerJson));
