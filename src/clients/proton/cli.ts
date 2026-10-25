import { Array, Context, Effect, HashSet, Layer, Schema } from "effect";
import { backupError, type BackupError } from "#domain/model.ts";
import { Commands } from "#process/commands.ts";
import { protonEnvironment } from "#clients/proton/state.ts";

const Name = Schema.Struct({ ok: Schema.Literal(true), value: Schema.NonEmptyString });
const Files = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Name, type: Schema.Literal("file") })),
);
const Folders = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Name, type: Schema.Literal("folder") })),
);

export class ProtonCli extends Context.Service<
  ProtonCli,
  {
    readonly list: (
      folder: string,
      type: "file" | "folder",
    ) => Effect.Effect<HashSet.HashSet<string>, BackupError>;
    readonly createFolder: (parent: string, name: string) => Effect.Effect<void, BackupError>;
    readonly upload: (folder: string, files: readonly string[]) => Effect.Effect<void, BackupError>;
    readonly trash: (files: readonly string[]) => Effect.Effect<void, BackupError>;
  }
>()("backup-runner/clients/proton/cli/ProtonCli") {
  public static readonly layer = Layer.effect(
    ProtonCli,
    Effect.gen(function* () {
      const commands = yield* Commands;
      const run = Effect.fn("ProtonCli.run")((args: readonly string[]) =>
        commands.run("proton-drive", ["filesystem", ...args], { env: protonEnvironment }),
      );
      const list = Effect.fn("ProtonCli.list")(
        function* (folder: string, type: "file" | "folder") {
          const result = yield* run(["list", "--json", "--type", type, folder]);
          const nodes = yield* Schema.decodeEffect(type === "file" ? Files : Folders)(
            result.stdout,
          );
          return HashSet.fromIterable(Array.map(nodes, (node) => node.name.value));
        },
        Effect.mapError(backupError("Proton listing")),
      );
      return ProtonCli.of({
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
