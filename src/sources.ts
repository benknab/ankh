import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Commands } from "./commands.ts";
import { type AbsolutePath, absolutePath, BackupError, type Job } from "./model.ts";
import { privateDirectory, Storage } from "./storage.ts";

const Repositories = Schema.Array(
  Schema.Struct({
    full_name: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
    ),
  }),
);

const stage = Effect.fn("Sources.stage")(
  function* (job: Job) {
    const { fs, path } = yield* Storage;
    const commands = yield* Commands;
    const directory = absolutePath(path.join("/staging", job.name));
    const source = job.source;
    if (source.type === "sqlite") {
      yield* fs.remove(directory, { recursive: true, force: true });
      yield* privateDirectory(directory);
      const output = path.join(directory, source.output);
      yield* commands.run("sqlite3", [
        `file:${source.path}?mode=ro`,
        ".timeout 60000",
        `.backup ${output}`,
      ]);
      const checked = yield* commands.run("sqlite3", [output, "PRAGMA quick_check;"]);
      if (checked !== "ok") {
        return yield* new BackupError({
          message: `SQLite quick_check failed: ${checked}`,
        });
      }
      return directory;
    }

    if (source.type === "postgres") {
      yield* fs.remove(directory, { recursive: true, force: true });
      yield* privateDirectory(directory);
      const output = path.join(directory, source.output);
      const password = (yield* fs.readFileString(source.passwordFile)).replace(/\r?\n$/, "");
      if (password.length === 0 || password.includes("\0")) {
        return yield* new BackupError({
          message: "Invalid PostgreSQL password file",
        });
      }
      yield* commands.run("pg_dump", ["--no-password", "--format=custom", "--file", output], {
        env: {
          PGHOST: source.hostname,
          PGPORT: String(source.port),
          PGDATABASE: source.database,
          PGUSER: source.username,
          PGPASSWORD: password,
          PGCONNECT_TIMEOUT: "30",
        },
      });
      // Read every archive entry without collecting the generated SQL in memory.
      yield* commands.run("pg_restore", ["--file=/dev/null", output]);
      return directory;
    }

    const token = (yield* fs.readFileString(source.tokenFile)).trim();
    yield* Schema.decodeEffect(Schema.NonEmptyString)(token);
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const base = source.apiUrl.replace(/\/$/, "");
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
    // Git LFS asks Git for Basic credentials; Gitea does not accept the API's
    // `token` header on its LFS endpoint. Keep the secret out of command args.
    const gitOptions = {
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
      yield* commands.run("git", ["-C", mirror, "fsck", "--full"]);
    }
    const manifest = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          createdAt: Schema.String,
          repositories: Schema.Array(Schema.String),
        }),
      ),
    )({
      createdAt: DateTime.formatIso(yield* DateTime.now),
      repositories: repositories.map((r) => r.full_name).sort(),
    });
    yield* fs.writeFileString(path.join(directory, "manifest.json"), manifest);
    return directory;
  },
  Effect.mapError((e) => new BackupError({ message: String(e) })),
);

export class Sources extends Context.Service<
  Sources,
  {
    readonly stage: (job: Job) => Effect.Effect<AbsolutePath, BackupError>;
  }
>()("backup-runner/Sources") {
  static readonly layer = Layer.effect(
    Sources,
    Effect.gen(function* () {
      const context = yield* Effect.context<Commands | Storage | HttpClient.HttpClient>();
      return Sources.of({
        stage: (job) => stage(job).pipe(Effect.provide(context)),
      });
    }),
  );
}
