import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Ref, Result } from "effect";
import { Base64 } from "effect/encoding";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { GitClient } from "#/clients/git.ts";
import { gitOptions } from "#/clients/git-auth.ts";
import { absolutePath } from "#/domain/model.ts";
import { Commands } from "#/process/commands.ts";
import { Storage } from "#/storage/storage.ts";
import { infrastructure } from "#/testing/infrastructure.ts";

const server = Effect.fn("Test.server")(function* (
  app: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >,
) {
  const context = yield* Layer.build(Layer.fresh(NodeHttpServer.layerTest));
  const http = Context.get(context, HttpServer.HttpServer);
  yield* http.serve(app);
  if (http.address._tag === "UnixPathAddress") {
    return yield* Effect.die("Expected TCP");
  }
  return `http://127.0.0.1:${http.address.port}`;
});

it.live("Git mirrors skip LFS and keep token authentication on the origin", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const commands = yield* Commands;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = path.join(root, "source");
    const mirror = path.join(root, "mirror.git");
    const tokenFile = absolutePath(path.join(root, "token"));
    yield* fs.writeFileString(tokenFile, "synthetic-token");
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 123\n`;
    const attacks = yield* Ref.make(0);
    const stolen = yield* Ref.make(0);
    const redirect = yield* Ref.make(false);
    const authenticated = yield* Ref.make(0);
    const attacker = yield* server(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Ref.update(attacks, (n) => n + 1);
        if (request.headers.authorization !== undefined) {
          yield* Ref.update(stolen, (n) => n + 1);
        }
        return HttpServerResponse.empty({
          status: 401,
          headers: { "www-authenticate": 'Basic realm="attacker"' },
        });
      }),
    );
    const trusted = yield* server(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.authorization === undefined) {
          return HttpServerResponse.empty({
            status: 401,
            headers: { "www-authenticate": 'Basic realm="trusted"' },
          });
        }
        yield* Ref.update(authenticated, (n) => n + 1);
        expect(request.headers.authorization).toBe(
          `Basic ${Base64.encode("oauth2:synthetic-token")}`,
        );
        if (yield* Ref.get(redirect)) {
          return HttpServerResponse.empty({
            status: 307,
            headers: { location: `${attacker}/steal` },
          });
        }
        return HttpServerResponse.text(`${"b".repeat(40)}\trefs/heads/main\n`);
      }),
    );
    yield* commands.run("git", ["init", "--initial-branch=main", source]);
    yield* fs.writeFileString(path.join(source, ".lfsconfig"), `[lfs]\nurl = ${attacker}/steal\n`);
    yield* fs.writeFileString(
      path.join(source, ".gitattributes"),
      "asset filter=lfs diff=lfs merge=lfs -text\n",
    );
    yield* fs.writeFileString(path.join(source, "asset"), pointer);
    yield* commands.run("git", [
      "-C",
      source,
      "-c",
      "filter.lfs.clean=cat",
      "-c",
      "filter.lfs.process=",
      "-c",
      "filter.lfs.required=false",
      "add",
      ".",
    ]);
    yield* commands.run("git", [
      "-C",
      source,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture",
    ]);
    const repository = { url: `${trusted}/owner/repo.git`, mirror, tokenFile };
    const localGit = Commands.of({
      run: (binary, args, options) => {
        const localArgs =
          args[0] === "clone"
            ? ["clone", "--mirror", source, mirror]
            : args.includes("set-url")
              ? [...args.slice(0, -1), source]
              : args;
        return commands.run(binary, localArgs, options);
      },
    });
    const client = GitClient.layer.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(Storage, yield* Storage), Layer.succeed(Commands, localGit)),
      ),
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      yield* Effect.gen(function* () {
        yield* (yield* GitClient).mirror(repository);
      }).pipe(Effect.provide(client));
      const blob = yield* commands.run("git", ["-C", mirror, "show", "HEAD:asset"]);
      expect(Redacted.value(blob.stdout)).toBe(pointer);
      expect(yield* fs.exists(path.join(mirror, "lfs"))).toBe(false);
    }
    expect(yield* Ref.get(authenticated)).toBe(0);
    expect(yield* Ref.get(attacks)).toBe(0);
    yield* commands.run("git", ["ls-remote", repository.url], gitOptions(repository));
    expect(yield* Ref.get(authenticated)).toBeGreaterThan(0);
    yield* Ref.set(redirect, true);
    const redirected = yield* commands
      .run("git", ["ls-remote", repository.url], gitOptions(repository))
      .pipe(Effect.result);
    expect(Result.isFailure(redirected)).toBe(true);
    expect(yield* Ref.get(stolen)).toBe(0);
    const denied = yield* commands
      .run("/app/gitea-askpass.sh", [`Password for '${attacker}': `], gitOptions(repository))
      .pipe(Effect.result);
    expect(Result.isFailure(denied)).toBe(true);
  }).pipe(Effect.provide(infrastructure)),
);
