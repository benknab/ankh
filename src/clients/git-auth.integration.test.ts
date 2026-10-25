import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Redacted, Ref, Result } from "effect";
import { Base64 } from "effect/encoding";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { GitClient } from "#clients/git.ts";
import { gitOptions } from "#clients/git-auth.ts";
import { absolutePath } from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { Storage } from "#storage/storage.ts";
import { infrastructure } from "#testing/infrastructure.ts";

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

it.live("repository LFS config cannot redirect the backup token", () =>
  Effect.gen(function* () {
    const { fs, path } = yield* Storage;
    const commands = yield* Commands;
    const root = yield* fs.makeTempDirectoryScoped();
    const source = path.join(root, "source");
    const mirror = path.join(root, "mirror.git");
    const tokenFile = absolutePath(path.join(root, "token"));
    yield* fs.writeFileString(tokenFile, "synthetic-token");
    const payload = "lfs-payload";
    yield* fs.writeFileString(path.join(root, "payload"), payload);
    const checksum = yield* commands.run("sha256sum", [path.join(root, "payload")]);
    const oid = Redacted.value(checksum.stdout).slice(0, 64);
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
    let trusted = "";
    trusted = yield* server(
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
        if (request.url.endsWith("/objects/batch")) {
          return yield* HttpServerResponse.json({
            objects: [
              { oid, size: payload.length, actions: { download: { href: `${trusted}/download` } } },
            ],
          }).pipe(Effect.orDie);
        }
        return HttpServerResponse.text(payload);
      }),
    );
    yield* commands.run("git", ["init", "--initial-branch=main", source]);
    yield* fs.writeFileString(path.join(source, ".lfsconfig"), `[lfs]\nurl = ${attacker}/steal\n`);
    yield* fs.writeFileString(
      path.join(source, ".gitattributes"),
      "asset filter=lfs diff=lfs merge=lfs -text\n",
    );
    yield* fs.writeFileString(
      path.join(source, "asset"),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`,
    );
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
    for (const existing of [false, true]) {
      if (existing) {
        yield* fs.remove(path.join(mirror, "lfs/objects"), { recursive: true });
      }
      yield* Effect.gen(function* () {
        yield* (yield* GitClient).mirror(repository);
      }).pipe(Effect.provide(client));
      expect(
        yield* fs.readFileString(
          path.join(mirror, "lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid),
        ),
      ).toBe(payload);
    }
    expect(yield* Ref.get(authenticated)).toBeGreaterThan(0);
    expect(yield* Ref.get(attacks)).toBe(0);
    yield* Ref.set(redirect, true);
    yield* fs.remove(path.join(mirror, "lfs/objects"), { recursive: true });
    const redirected = yield* Effect.gen(function* () {
      yield* (yield* GitClient).mirror(repository);
    }).pipe(Effect.provide(client), Effect.result);
    expect(Result.isFailure(redirected)).toBe(true);
    expect(yield* Ref.get(stolen)).toBe(0);
    const denied = yield* commands
      .run("/app/gitea-askpass.sh", [`Password for '${attacker}': `], gitOptions(repository))
      .pipe(Effect.result);
    expect(Result.isFailure(denied)).toBe(true);
  }).pipe(Effect.provide(infrastructure)),
);
