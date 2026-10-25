import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import { Job, RemoteFolder } from "#domain/model.ts";
import { fixture } from "#testing/fixtures.ts";

it.effect("schemas reject unsafe paths, names, duplicate destinations, and empty retention", () =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Job)(fixture);
    for (const input of [
      { ...fixture, name: "../escape" },
      { ...fixture, source: { ...fixture.source, output: "../escape" } },
      { ...fixture, destinations: [fixture.destinations[0], fixture.destinations[0]] },
      { ...fixture, retention: { daily: 0, weekly: 0, monthly: 0, yearly: 0 } },
    ]) {
      const result = yield* Schema.decodeUnknownEffect(Job)(input).pipe(Effect.result);
      expect(Result.isFailure(result), "invalid job must fail at the boundary").toBe(true);
    }
  }),
);

it.effect("configuration rejects unknown keys, invalid schedules, and destructive overlaps", () =>
  Effect.gen(function* () {
    for (const input of [
      { ...fixture, ignored: true },
      { ...fixture, source: { ...fixture.source, ignored: true } },
      { ...fixture, retention: { ...fixture.retention, ignored: true } },
      { ...fixture, schedule: { cron: "invalid", timeZone: "UTC" } },
      { ...fixture, schedule: { cron: "0 0 31 2 *", timeZone: "UTC" } },
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
      {
        ...fixture,
        destinations: [{ type: "proton-drive", remoteFolder: "/my-files/a", outbox: "/secrets" }],
      },
    ]) {
      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Job, { onExcessProperty: "error" })(input).pipe(
            Effect.result,
          ),
        ),
        "unsafe config must fail",
      ).toBe(true);
    }
    yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      schedule: { cron: "30 3 * * *", timeZone: "Europe/Paris" },
    });
    yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      schedule: { cron: "0 0 29 2 *", timeZone: "UTC" },
    });
  }),
);

it.effect("every job requires a cron expression and defaults an omitted time zone to UTC", () =>
  Effect.gen(function* () {
    const { schedule, ...withoutSchedule } = fixture;
    const job = yield* Schema.decodeUnknownEffect(Job)(fixture);
    expect(job.schedule).toEqual(schedule);
    const defaulted = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      schedule: { cron: schedule.cron },
    });
    expect(defaulted.schedule).toEqual({ cron: schedule.cron, timeZone: "UTC" });
    for (const input of [
      withoutSchedule,
      { ...fixture, schedule: null },
      { ...fixture, schedule: {} },
      { ...fixture, schedule: { cron: schedule.cron, timeZone: null } },
      { ...fixture, schedule: { timeZone: schedule.timeZone } },
    ]) {
      const result = yield* Schema.decodeUnknownEffect(Job)(input).pipe(Effect.result);
      expect(Result.isFailure(result), "missing schedule fields must fail validation").toBe(true);
    }
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
      expect(
        Result.isFailure(yield* Schema.decodeEffect(RemoteFolder)(folder).pipe(Effect.result)),
        "unsafe folder must fail",
      ).toBe(true);
    }
  }),
);

it.effect("configuration reserves the drive lock path for cleanup", () =>
  Effect.gen(function* () {
    for (const root of ["/drive/.runner-lock", "/drive/.runner-lock/nested"]) {
      for (const destination of [
        { type: "restic", repository: root, passwordFile: "/password" },
        { type: "proton-drive", outbox: root, remoteFolder: "/my-files/a" },
      ]) {
        expect(
          Result.isFailure(
            yield* Schema.decodeUnknownEffect(Job)({
              ...fixture,
              destinations: [destination],
            }).pipe(Effect.result),
          ),
        ).toBe(true);
      }
      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Job)({
            ...fixture,
            source: { ...fixture.source, path: root },
          }).pipe(Effect.result),
        ),
      ).toBe(true);
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
      expect(
        Result.isFailure(
          yield* Schema.decodeUnknownEffect(Job)({
            ...fixture,
            source: { type: "gitea-git", apiUrl, tokenFile: "/token" },
          }).pipe(Effect.result),
        ),
        "unsafe URL must fail",
      ).toBe(true);
    }
    yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      source: { type: "gitea-git", apiUrl: "https://example.com/gitea/", tokenFile: "/token" },
    });
  }),
);
