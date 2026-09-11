import { Layer } from "effect";
import { SshTransportLive } from "../ssh";
import { SettingsLive } from "../settings/service";
import { HermesPlaneLive } from "./plane";
import { HermesTransportLive } from "./transport";

export const HermesStandaloneLive = Layer.provideMerge(
  HermesPlaneLive,
  Layer.mergeAll(
    Layer.provideMerge(HermesTransportLive, SshTransportLive),
    SettingsLive,
  ),
);
