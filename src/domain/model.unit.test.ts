import { it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { Job, RemoteFolder } from "#domain/model.ts";
import { assert, fixture } from "#testing/fixtures.ts";

it.effect("configuration rejects unknown keys, invalid schedules, and destructive overlaps", () =>
  Effect.gen(function* () {
    for (const input of [
      { ...fixture, ignored: true },
      { ...fixture, source: { ...fixture.source, ignored: true } },
      { ...fixture, retention: { ...fixture.retention, ignored: true } },
      { ...fixture, schedule: { cron: "invalid", timeZone: "UTC" } },
      { ...fixture, schedule: { cron: "30 3 * * *", timeZone: "Invalid/Zone" } },
      { ...fixture, source: { ...fixture.source, path: "/staging/test-job/source.db" } },
      { ...fixture, source: { ...fixture.source, path: "/staging" } },
      { ...fixture, source: { ...fixture.source, path: "/source//test.db" } },
      {
        ...fixture,
        destinations: [{ type: "restic", repository: "/drive", passwordFile: "/password" }],
      },
      {
        ...fixture,
        destinations: [
          { type: "proton-drive", remoteFolder: "/my-files/a", outbox: "/proton/queue" },
        ],
      },
    ]) {
      yield* assert(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Job, { onExcessProperty: "error" })(input).pipe(
            Effect.result,
          ),
        ),
        `unsafe config must fail: ${JSON.stringify(input)}`,
      );
    }
    yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      schedule: { cron: "30 3 * * *", timeZone: "Europe/Paris" },
    });
  }),
);

it.effect("Proton folders validate every segment including one-character names", () =>
  Effect.gen(function* () {
    for (const folder of ["/my-files/a", "/my-files/Backups/host/job"]) {
      yield* Schema.decodeEffect(RemoteFolder)(folder);
    }
    for (const folder of [
      "/my-files/a/",
      "/my-files/a//b",
      "/my-files/a/..",
      "/my-files/a\\",
      "/my-files/a\0",
    ]) {
      yield* assert(
        Result.isFailure(yield* Schema.decodeEffect(RemoteFolder)(folder).pipe(Effect.result)),
        "unsafe folder must fail",
      );
    }
  }),
);

it.effect("Gitea URLs reject credentials, queries, and fragments", () =>
  Effect.gen(function* () {
    for (const apiUrl of [
      "https://user:secret@example.com",
      "https://example.com?token=x",
      "https://example.com/#fragment",
      "file:///source",
    ]) {
      yield* assert(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Job)({
            ...fixture,
            source: { type: "gitea-git", apiUrl, tokenFile: "/token" },
          }).pipe(Effect.result),
        ),
        "unsafe URL must fail",
      );
    }
    yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      source: { type: "gitea-git", apiUrl: "https://example.com/gitea/", tokenFile: "/token" },
    });
  }),
);
