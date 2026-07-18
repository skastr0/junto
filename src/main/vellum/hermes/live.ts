import { Layer } from "effect";
import { SshTransportLive } from "../ssh";
import { HermesPlaneLive } from "./plane";
import { HermesTransportLive } from "./transport";

export const HermesStandaloneLive = Layer.provideMerge(
  HermesPlaneLive,
  Layer.provideMerge(HermesTransportLive, SshTransportLive),
);
