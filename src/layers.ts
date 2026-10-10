import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Commands } from "./commands.ts";
import { Destinations } from "./destinations.ts";
import { Outbox } from "./outbox.ts";
import { ProtonDrive } from "./proton.ts";
import { Sources } from "./sources.ts";
import { Storage } from "./storage.ts";

const platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const infrastructure = Layer.mergeAll(Commands.layer, Storage.layer).pipe(
  Layer.provideMerge(platform),
);
const adapters = Layer.mergeAll(Outbox.layer, ProtonDrive.layer, Sources.layer).pipe(
  Layer.provideMerge(infrastructure),
);
export const Live = Destinations.layer.pipe(Layer.provideMerge(adapters));
