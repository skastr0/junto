import { Context, type Effect } from "effect";
import type { InstallationId } from "@shared/installation-id";
import type { RemoteHost } from "@shared/remote-hosts";
import type { MachinePeer } from "../machines/repository";
import type { LinkChannel, LinkChannels, MachineLinkError } from "./types";

export {
  isMachineLinkError, LinkBuildMismatch, LinkClosed, LinkFrameInvalid, LinkHelloRefused, LinkPeerNotPinned, LinkRequestFailed, LinkUnavailable,
} from "./types";
export type { LinkChannelContext, LinkChannelHandler, LinkChannels, MachineLinkError } from "./types";

export interface MachineLinkListener {
  readonly socketPath: string;
  readonly ready: () => boolean;
  /** Closes each admitted session with `cause` (a close frame the peer reads), then drops the rest. */
  readonly beginShutdown: (cause?: unknown) => void;
  readonly close: (cause?: unknown) => Promise<void>;
}

export interface LinkRequestOptions {
  /** The operation this request belongs to, minted by its caller; omitted, the link mints one. */
  readonly operationId?: string;
}

export class MachineLink extends Context.Service<MachineLink, {
  readonly setChannels: (channels: LinkChannels) => Effect.Effect<void, MachineLinkError>;
  readonly listen: (home: string) => Effect.Effect<MachineLinkListener, MachineLinkError>;
  readonly connect: (host: RemoteHost) => Effect.Effect<MachinePeer, MachineLinkError>;
  /** Owner send/setup only; the installation id is a strictly decoded installer receipt. */
  readonly connectSetup: (host: RemoteHost, expectedInstallationId: InstallationId) => Effect.Effect<MachinePeer, MachineLinkError>;
  /** Closes the link to a machine; a cause is logged at both ends and sent to the peer. */
  readonly disconnect: (name: string, cause?: unknown) => Effect.Effect<void, MachineLinkError>;
  readonly peerBuild: (name: string) => Effect.Effect<string | undefined>;
  readonly request: (name: string, channel: LinkChannel, payload: unknown, options?: LinkRequestOptions) => Effect.Effect<unknown, MachineLinkError>;
  readonly sendEvent: (name: string, channel: LinkChannel, payload: unknown) => Effect.Effect<void, MachineLinkError>;
}>()("@junto/MachineLink") {}
