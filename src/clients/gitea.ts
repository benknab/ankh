import { Array, Context, Effect, HashSet, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { backupError, type BackupError, type Gitea } from "#/domain/model.ts";
import { Storage } from "#/storage/storage.ts";
import { readSecret } from "#/storage/secrets.ts";

const Repository = Schema.Struct({
  full_name: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u),
  ),
});
const Repositories = Schema.Array(Repository);
export type Repository = typeof Repository.Type;

export class GiteaClient extends Context.Service<
  GiteaClient,
  {
    readonly repositories: (
      source: typeof Gitea.Type,
    ) => Effect.Effect<readonly Repository[], BackupError>;
  }
>()("ankh/clients/gitea/GiteaClient") {
  public static readonly layer = Layer.effect(
    GiteaClient,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const storage = yield* Storage;
      const repositories = Effect.fn("GiteaClient.repositories")(
        function* (source: typeof Gitea.Type) {
          const token = yield* readSecret(source.tokenFile).pipe(
            Effect.provideService(Storage, storage),
          );
          const base = source.apiUrl.href.replace(/\/$/u, "");
          let names = HashSet.empty<string>();
          for (let page = 1; ; page += 1) {
            const response = yield* client.get(`${base}/api/v1/user/repos`, {
              headers: { Authorization: `token ${Redacted.value(token)}` },
              urlParams: { limit: 50, page },
            });
            const batch = yield* HttpClientResponse.schemaBodyJson(Repositories)(response);
            for (const repository of batch) {
              names = HashSet.add(names, repository.full_name);
            }
            if (batch.length === 0) {
              return Array.map(Array.fromIterable(names), (full_name) => ({ full_name }));
            }
          }
        },
        Effect.mapError(backupError("Gitea repository discovery")),
      );
      return GiteaClient.of({ repositories });
    }),
  );
}
