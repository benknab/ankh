import { Array, Context, Effect, HashSet, Layer, Redacted, Schema } from "effect";
import { backupError, BackupError } from "#/domain/model.ts";
import { Commands } from "#/process/commands.ts";
import { runProton } from "#/clients/proton/command.ts";
import { verifyCredentials } from "#/clients/proton/credentials.ts";
import { Storage } from "#/storage/storage.ts";

const Name = Schema.Struct({ ok: Schema.Literal(true), value: Schema.NonEmptyString });
const Files = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Name, type: Schema.Literal("file") })),
);
const Folders = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Name, type: Schema.Literal("folder") })),
);
// CLI 0.8.0 ignores --type for shared-with-me listings, including descendants.
const SharedNodes = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Name, type: Schema.Literals(["file", "folder"]) })),
);

export class ProtonCli extends Context.Service<
  ProtonCli,
  {
    readonly verify: Effect.Effect<void, BackupError>;
    readonly list: (
      folder: string,
      type: "file" | "folder",
    ) => Effect.Effect<HashSet.HashSet<string>, BackupError>;
    readonly createFolder: (parent: string, name: string) => Effect.Effect<void, BackupError>;
    readonly upload: (folder: string, files: readonly string[]) => Effect.Effect<void, BackupError>;
    readonly trash: (files: readonly string[]) => Effect.Effect<void, BackupError>;
  }
>()("ankh/clients/proton/cli/ProtonCli") {
  public static readonly layer = Layer.effect(
    ProtonCli,
    Effect.gen(function* () {
      const context = (yield* Effect.context<Commands | Storage>()).pipe(
        Context.pick(Commands, Storage),
      );
      const run = Effect.fn("ProtonCli.run")((args: readonly string[]) =>
        runProton("proton-drive", ["filesystem", ...args]).pipe(Effect.provide(context)),
      );
      const list = Effect.fn("ProtonCli.list")(
        function* (folder: string, type: "file" | "folder") {
          const result = yield* run(["list", "--json", "--type", type, folder]);
          const shared = folder === "/shared-with-me" || folder.startsWith("/shared-with-me/");
          const schema = shared ? SharedNodes : type === "file" ? Files : Folders;
          const nodes = yield* Schema.decodeEffect(schema)(Redacted.value(result.stdout));
          const names = HashSet.fromIterable(Array.map(nodes, (node) => node.name.value));
          if (HashSet.size(names) !== nodes.length) {
            return yield* BackupError.make({
              message: "Proton listing contains duplicate names; resolve them before retrying",
            });
          }
          return HashSet.fromIterable(
            Array.map(
              Array.filter(nodes, (node) => node.type === type),
              (node) => node.name.value,
            ),
          );
        },
        Effect.mapError(backupError("Proton listing")),
      );
      return ProtonCli.of({
        verify: verifyCredentials().pipe(Effect.provide(context)),
        list,
        createFolder: (parent, name) => run(["create-folder", parent, name]).pipe(Effect.asVoid),
        upload: (folder, files) =>
          run([
            "upload",
            "--file-conflict-strategy",
            "create-new-revision",
            "--skip-thumbnails",
            ...files,
            folder,
          ]).pipe(Effect.asVoid),
        trash: (files) => run(["trash", "--json", ...files]).pipe(Effect.asVoid),
      });
    }),
  );
}
