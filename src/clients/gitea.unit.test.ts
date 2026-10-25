import { expect, it } from "@effect/vitest";
import { Array, Effect, FileSystem, Layer, Path, Ref, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { GiteaClient } from "#/clients/gitea.ts";
import { Gitea } from "#/domain/model.ts";
import { Storage } from "#/storage/storage.ts";

const source = Schema.decodeEffect(Gitea)({
  type: "gitea-git",
  apiUrl: "https://example.com/gitea/",
  tokenFile: "/token",
});
const storage = Storage.layer.pipe(
  Layer.provide(
    Layer.merge(
      Path.layer,
      FileSystem.layerNoop({ readFileString: () => Effect.succeed("synthetic-token\n") }),
    ),
  ),
);

it.effect("Gitea follows pages under the base path and rejects an unsafe repository name", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make(0);
    const transport = HttpClient.make(
      Effect.fn("Test.gitea")(function* (request) {
        const page = yield* Ref.updateAndGet(requests, (n) => n + 1);
        expect(request.url).toBe("https://example.com/gitea/api/v1/user/repos");
        expect(request.urlParams).toContainEqual(["page", String(page)]);
        expect(request.headers.authorization).toBe("token synthetic-token");
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          page === 1
            ? Array.makeBy(50, (n) => ({ full_name: `owner/repo-${n}` }))
            : [{ full_name: "../escape" }],
        ).pipe(Effect.orDie);
        return HttpClientResponse.fromWeb(request, new Response(body));
      }),
    );
    const layer = GiteaClient.layer.pipe(
      Layer.provide(Layer.merge(storage, Layer.succeed(HttpClient.HttpClient, transport))),
    );
    const result = yield* Effect.gen(function* () {
      return yield* (yield* GiteaClient).repositories(yield* source);
    }).pipe(Effect.provide(layer), Effect.result);
    expect(yield* Ref.get(requests)).toBe(2);
    expect(Result.isFailure(result)).toBe(true);
  }),
);

it.effect("Gitea HTTP failures remain typed failures", () =>
  Effect.gen(function* () {
    const transport = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("unauthorized", { status: 401 })),
      ),
    );
    const layer = GiteaClient.layer.pipe(
      Layer.provide(Layer.merge(storage, Layer.succeed(HttpClient.HttpClient, transport))),
    );
    const result = yield* Effect.gen(function* () {
      return yield* (yield* GiteaClient).repositories(yield* source);
    }).pipe(Effect.provide(layer), Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result) && result.failure._tag === "BackupError") {
      expect(result.failure.operation).toBe("Gitea repository discovery");
    }
  }),
);

it.effect("Gitea continues through server-capped pages until an empty page", () =>
  Effect.gen(function* () {
    let page = 0;
    const transport = HttpClient.make(
      Effect.fn("Test.cappedPages")(function* (request) {
        page += 1;
        const count = page === 1 ? 20 : page === 2 ? 5 : 0;
        const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          count === 0
            ? []
            : Array.makeBy(count, (n) => ({ full_name: `owner/page-${page}-repo-${n}` })),
        ).pipe(Effect.orDie);
        return HttpClientResponse.fromWeb(request, new Response(body));
      }),
    );
    const repositories = yield* Effect.gen(function* () {
      return yield* (yield* GiteaClient).repositories(yield* source);
    }).pipe(
      Effect.provide(
        GiteaClient.layer.pipe(
          Layer.provide(Layer.merge(storage, Layer.succeed(HttpClient.HttpClient, transport))),
        ),
      ),
    );
    expect(repositories).toHaveLength(25);
    expect(page).toBe(3);
  }),
);
