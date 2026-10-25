import { expect, it } from "@effect/vitest";
import { Array, Effect, Fiber, FileSystem, Layer, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import { GitClient } from "#/clients/git.ts";
import { GiteaClient } from "#/clients/gitea.ts";
import { absolutePath, BackupError, Gitea } from "#/domain/model.ts";
import { gitAdapter } from "#/sources/gitea.ts";
import { Storage } from "#/storage/storage.ts";

const source = Schema.decodeEffect(Gitea)({
  type: "gitea-git",
  apiUrl: "https://example.com/gitea/",
  tokenFile: "/token",
});
const repositories = Array.makeBy(8, (n) => ({ full_name: `owner/repo-${n}` }));
const layer = (
  git: GitClient["Service"],
  manifests: string[],
): Layer.Layer<GitClient | GiteaClient | Storage> =>
  Layer.mergeAll(
    Layer.succeed(GitClient, git),
    Layer.succeed(GiteaClient, { repositories: () => Effect.succeed(repositories) }),
    Storage.layer.pipe(
      Layer.provide(
        Layer.merge(
          Path.layer,
          FileSystem.layerNoop({
            makeDirectory: () => Effect.void,
            chmod: () => Effect.void,
            writeFileString: (_path, content) =>
              Effect.sync(() => {
                manifests.push(content);
              }),
          }),
        ),
      ),
    ),
  );

it.effect("Gitea staging overlaps four mirrors and publishes only after all finish", () =>
  Effect.gen(function* () {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const manifests: string[] = [];
    const git = GitClient.of({
      mirror: () =>
        Effect.gen(function* () {
          active += 1;
          peak = Math.max(peak, active);
          yield* Effect.sleep("1 second");
          completed += 1;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active -= 1;
            }),
          ),
        ),
    });
    const fiber = yield* Effect.forkChild(
      gitAdapter
        .stage(yield* source, absolutePath("/stage"))
        .pipe(Effect.provide(layer(git, manifests))),
    );
    yield* TestClock.adjust("1 second");
    expect(completed).toBe(4);
    expect(active).toBe(4);
    expect(manifests).toHaveLength(0);
    yield* TestClock.adjust("1 second");
    expect(yield* Fiber.join(fiber)).toBe("/stage");
    expect(completed).toBe(8);
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(manifests).toHaveLength(1);
    const manifest = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ repositories: Schema.Array(Schema.String) })),
    )(manifests[0] ?? "");
    expect(manifest.repositories).toEqual(
      Array.map(repositories, (repository) => repository.full_name),
    );
  }),
);

it.effect("a failed mirror cancels active workers before staging returns without a manifest", () =>
  Effect.gen(function* () {
    let active = 0;
    let started = 0;
    const manifests: string[] = [];
    const git = GitClient.of({
      mirror: (repository) =>
        Effect.gen(function* () {
          active += 1;
          started += 1;
          if (repository.url.endsWith("repo-0.git")) {
            yield* Effect.sleep("1 second");
            return yield* BackupError.make({ message: "injected mirror failure" });
          }
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active -= 1;
            }),
          ),
        ),
    });
    const fiber = yield* Effect.forkChild(
      gitAdapter
        .stage(yield* source, absolutePath("/stage"))
        .pipe(Effect.provide(layer(git, manifests)), Effect.flip),
    );
    yield* TestClock.adjust("1 second");
    expect((yield* Fiber.join(fiber)).message).toBe("injected mirror failure");
    expect(started).toBe(4);
    expect(active).toBe(0);
    expect(manifests).toHaveLength(0);
  }),
);
