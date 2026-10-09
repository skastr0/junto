import { Context, type Effect } from "effect";
import type { InstallationId } from "@shared/installation-id";
import type { RemoteHost } from "@shared/remote-hosts";
import type { MachinePeer } from "../machines/repository";
import type { LinkChannel, LinkChannels, MachineLinkError } from "./types";

export { MachineLinkError } from "./types";
export type { LinkChannelContext, LinkChannelHandler, LinkChannels } from "./types";

export interface MachineLinkListener {
  readonly socketPath: string;
  readonly ready: () => boolean;
  readonly beginShutdown: () => void;
  readonly close: () => Promise<void>;
}

export class MachineLink extends Context.Service<MachineLink, {
  readonly setChannels: (channels: LinkChannels) => Effect.Effect<void, MachineLinkError>;
  readonly listen: (home: string) => Effect.Effect<MachineLinkListener, MachineLinkError>;
  readonly connect: (host: RemoteHost) => Effect.Effect<MachinePeer, MachineLinkError>;
  /** Owner send/setup only; the installation id is a strictly decoded installer receipt. */
  readonly connectSetup: (host: RemoteHost, expectedInstallationId: InstallationId) => Effect.Effect<MachinePeer, MachineLinkError>;
  readonly disconnect: (name: string) => Effect.Effect<void, MachineLinkError>;
  readonly peerBuild: (name: string) => Effect.Effect<string | undefined>;
  readonly request: (name: string, channel: LinkChannel, payload: unknown) => Effect.Effect<unknown, MachineLinkError>;
  readonly sendEvent: (name: string, channel: LinkChannel, payload: unknown) => Effect.Effect<void, MachineLinkError>;
}>()("@junto/MachineLink") {}
