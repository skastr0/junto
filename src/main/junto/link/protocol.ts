import { Schema } from "effect";
import { EncodedFailure, OperationId } from "@shared/failure";
import { InstallationId } from "@shared/installation-id";
import { MachineBuild, MachineName } from "@shared/machine-control";

export const LinkHelloSchema = Schema.Struct({ build: MachineBuild, installationId: InstallationId, machineName: MachineName });
const Id = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64)), Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)));
const Channel = Schema.Literals(["rows", "seats", "status", "inventory", "settings", "native-config", "content", "consensus", "authority"]);
/** The largest frame as read, its 1 MiB bound plus the newline: a window and the most one credit returns. */
export const LINK_EVENT_WINDOW = 1024 * 1024 + 1;
const CreditBytes = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: LINK_EVENT_WINDOW })));
export const LinkFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), ...LinkHelloSchema.fields }),
  Schema.Struct({ type: Schema.Literal("request"), id: Id, op: OperationId, channel: Channel, payload: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("response"), id: Id, op: OperationId, channel: Channel, ok: Schema.Literal(true), payload: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("response"), id: Id, op: OperationId, channel: Channel, ok: Schema.Literal(false), failure: EncodedFailure }),
  Schema.Struct({ type: Schema.Literal("event"), channel: Channel, payload: Schema.Json }),
  /** A windowed channel's event bytes, as read, whose handlers have finished. */
  Schema.Struct({ type: Schema.Literal("credit"), channel: Channel, bytes: CreditBytes }),
  /**
   * Written by this machine's own relay, before any byte from the far end,
   * when the SSH key that ran it is bound to one opener (`junto link --opener`).
   * Taken only as the first frame of an accepted connection.
   */
  Schema.Struct({ type: Schema.Literal("opener"), installationId: InstallationId }),
  /** Sent once by the end that closes, so the other end can say who closed and why. */
  Schema.Struct({ type: Schema.Literal("close"), failure: EncodedFailure }),
]);
export type LinkFrame = typeof LinkFrame.Type;
const decode = Schema.decodeUnknownSync(LinkFrame, { onExcessProperty: "error" });
export class LinkFramePayloadMissing extends Schema.TaggedError<LinkFramePayloadMissing>()("LinkFramePayloadMissing", { message: Schema.String }) {}
export const decodeLinkFrame = (input: unknown): LinkFrame => {
  const frame = decode(input);
  if ((frame.type === "request" || frame.type === "event" || (frame.type === "response" && frame.ok)) && !Object.hasOwn(frame, "payload")) throw new LinkFramePayloadMissing({ message: "link frame requires payload" });
  return frame;
};
