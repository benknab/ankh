import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Commands } from "#process/commands.ts";
import { Job } from "#domain/model.ts";
import { Sources } from "#sources/sources.ts";
import { Storage } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";
import { fixture } from "#testing/fixtures.ts";

it.live("Gitea staging updates a persistent mirror and restores Git and LFS contents", () =>
  Effect.gen(function* () {
    const storage = yield* Storage;
    const { fs, path } = storage;
    const commands = yield* Commands;
    const root = yield* fs.makeTempDirectoryScoped();
    const repository = path.join(root, "source");
    yield* commands.run("git", ["init", "--initial-branch=main", repository]);
    const git = Effect.fn("Test.git")((args: readonly string[]) =>
      commands.run("git", ["-C", repository, ...args]),
    );
    yield* git(["config", "user.name", "Test Author"]);
    yield* git(["config", "user.email", "test@example.com"]);
    yield* git(["config", "commit.gpgsign", "false"]);
    yield* git(["lfs", "install", "--local"]);
    yield* git(["lfs", "track", "*.bin"]);
    yield* fs.writeFileString(path.join(repository, "asset.bin"), "lfs-data".repeat(1024));
    yield* fs.writeFileString(path.join(repository, "README"), "first revision");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "Initial test fixture"]);
    const tokenFile = path.join(root, "token");
    yield* fs.writeFileString(tokenFile, "synthetic-token");
    const job = yield* Schema.decodeUnknownEffect(Job)({
      ...fixture,
      name: "gitea-test",
      source: { type: "gitea-git", apiUrl: "https://example.com/gitea/", tokenFile },
    });
    const transport = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response('[{"full_name":"example/repository"}]', {
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    );
    const testCommands = Commands.of({
      run: (binary, args, options) =>
        binary === "git" && args[0] === "clone"
          ? Effect.gen(function* () {
              expect(args[2], "clone URL must preserve the base path").toBe(
                "https://example.com/gitea/example/repository.git",
              );
              const target = yield* Schema.decodeUnknownEffect(Schema.String)(args[3]).pipe(
                Effect.orDie,
              );
              return yield* commands.run(
                binary,
                ["clone", "--mirror", repository, target],
                options,
              );
            })
          : commands.run(binary, args, options),
    });
    const sources = Sources.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Storage, storage),
          Layer.succeed(Commands, testCommands),
          Layer.succeed(HttpClient.HttpClient, transport),
        ),
      ),
    );
    const stage = Effect.gen(function* () {
      return yield* (yield* Sources).stage(job);
    }).pipe(Effect.provide(sources));
    yield* stage;
    yield* fs.writeFileString(path.join(repository, "README"), "second revision");
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "Update test fixture"]);
    const directory = yield* stage;
    const restored = path.join(root, "restored");
    yield* commands.run(
      "git",
      ["clone", path.join(directory, "repositories/example/repository.git"), restored],
      { env: { GIT_LFS_SKIP_SMUDGE: "1" } },
    );
    yield* commands.run("git", ["-C", restored, "lfs", "pull"]);
    expect(
      yield* fs.readFileString(path.join(restored, "README")),
      "mirror must update existing refs",
    ).toBe("second revision");
    expect(
      yield* fs.readFileString(path.join(restored, "asset.bin")),
      "LFS objects must restore",
    ).toBe("lfs-data".repeat(1024));
  }).pipe(Effect.provide(infrastructure)),
);
