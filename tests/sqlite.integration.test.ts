import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { Commands } from "../src/commands.ts";
import { Job } from "../src/model.ts";
import { Sources } from "../src/sources.ts";
import { Storage } from "../src/storage.ts";
import { infrastructure } from "./integration-support.ts";
import { assert, fixture } from "./support.ts";

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
    yield* assert(
      (yield* commands.run("sqlite3", [
        path.join(staged, "test.db"),
        "SELECT value FROM records;",
      ])) === "verified",
      "staging must read the exact source path",
    );
  }).pipe(
    Effect.provide(
      Sources.layer.pipe(Layer.provideMerge(Layer.mergeAll(infrastructure, FetchHttpClient.layer))),
    ),
  ),
);
