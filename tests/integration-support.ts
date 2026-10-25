import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";
import { Commands } from "../src/commands.ts";
import { Outbox } from "../src/outbox.ts";
import { Storage } from "../src/storage.ts";

export const infrastructure = Layer.mergeAll(Commands.layer, Storage.layer).pipe(
  Layer.provideMerge(NodeServices.layer),
);

export const outboxInfrastructure = Outbox.layer.pipe(Layer.provideMerge(infrastructure));
