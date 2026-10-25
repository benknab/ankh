import { DateTime, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Commands, type Options } from "../process/commands.ts";
import { type AbsolutePath, type Gitea } from "../domain/model.ts";
import { privateDirectory, Storage } from "../storage/storage.ts";

const Repositories = Schema.Array(
  Schema.Struct({
    full_name: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
    ),
  }),
);

export const stageGitea = Effect.fn("Gitea.stage")(function* (
  source: typeof Gitea.Type,
  directory: AbsolutePath,
) {
  const { fs, path } = yield* Storage;
  const commands = yield* Commands;
  const token = (yield* fs.readFileString(source.tokenFile)).trim();
  yield* Schema.decodeEffect(Schema.NonEmptyString)(token);
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const base = source.apiUrl.href.replace(/\/$/, "");
  const repositories: Array<(typeof Repositories.Type)[number]> = [];
  for (let page = 1; ; page++) {
    const response = yield* client.get(`${base}/api/v1/user/repos`, {
      headers: { Authorization: `token ${token}` },
      urlParams: { limit: 50, page },
    });
    const batch = yield* HttpClientResponse.schemaBodyJson(Repositories)(response);
    repositories.push(...batch);
    if (batch.length < 50) {
      break;
    }
  }
  yield* privateDirectory(directory);
  // Preserve the mirror cache; Git LFS uses askpass for Basic authentication.
  const gitOptions: Options = {
    output: "tail",
    redact: [token],
    env: {
      GIT_ASKPASS: "/app/gitea-askpass.sh",
      GIT_TERMINAL_PROMPT: "0",
      GITEA_TOKEN_FILE: source.tokenFile,
    },
  };
  for (const repository of repositories) {
    const mirror = path.join(directory, "repositories", `${repository.full_name}.git`);
    yield* privateDirectory(path.dirname(mirror));
    if (yield* fs.exists(mirror)) {
      yield* commands.run("git", ["-C", mirror, "remote", "update", "--prune"], gitOptions);
    } else {
      yield* commands.run(
        "git",
        ["clone", "--mirror", `${base}/${repository.full_name}.git`, mirror],
        gitOptions,
      );
    }
    yield* commands.run("git", ["-C", mirror, "lfs", "fetch", "--all", "origin"], gitOptions);
    yield* commands.run("git", ["-C", mirror, "fsck", "--full"], gitOptions);
  }
  const manifest = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ createdAt: Schema.String, repositories: Schema.Array(Schema.String) }),
    ),
  )({
    createdAt: DateTime.formatIso(yield* DateTime.now),
    repositories: repositories.map((r) => r.full_name).sort(),
  });
  yield* fs.writeFileString(path.join(directory, "manifest.json"), manifest);
  return directory;
});
