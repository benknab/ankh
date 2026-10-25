import { NodeServices } from "@effect/platform-node";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Commands } from "#/process/commands.ts";
import { Destinations } from "#/destinations/destinations.ts";
import { Outbox } from "#/outbox/outbox.ts";
import { ProtonDrive } from "#/clients/proton/client.ts";
import { Sources } from "#/sources/sources.ts";
import { Storage } from "#/storage/storage.ts";
import { Telemetry } from "#/telemetry/otlp.ts";

const platform = Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer);
const infrastructure = Layer.mergeAll(Commands.layer, Storage.layer).pipe(
  Layer.provideMerge(platform),
);
const adapters = Layer.mergeAll(Outbox.layer, ProtonDrive.layer, Sources.layer).pipe(
  Layer.provideMerge(infrastructure),
);
const telemetry = Telemetry.pipe(Layer.provide(FetchHttpClient.layer));
export const Live = Destinations.layer.pipe(
  Layer.provideMerge(adapters),
  Layer.provideMerge(telemetry),
);
