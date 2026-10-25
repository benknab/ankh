import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Commands } from "#process/commands.ts";
import { Job } from "#domain/model.ts";
import { Sources } from "#sources/sources.ts";
import { Storage } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";
import { fixture } from "#testing/fixtures.ts";

it.live("SQLite staging preserves URI-special characters in source paths", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const commands = yield* Commands;
    const sources = yield* Sources;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = path.join(root, "database ?#% name.db");
    yield* commands.run("sqlite3", [
      source,
      "CREATE TABLE records(value TEXT); INSERT INTO records VALUES ('verified');",
    ]);
    const job = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      name: "sqlite-uri",
      source: { ...fixture.source, path: source },
    });
    const staged = yield* sources.stage(job);
    expect(
      (yield* commands.run("sqlite3", [path.join(staged, "test.db"), "SELECT value FROM records;"]))
        .stdout,
      "staging must read the exact source path",
    ).toBe("verified");
  }).pipe(
    Effect.provide(
      Sources.layer.pipe(Layer.provideMerge(Layer.mergeAll(infrastructure, FetchHttpClient.layer))),
    ),
  ),
);
