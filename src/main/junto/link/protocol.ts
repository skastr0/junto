import { Schema } from "effect";
import { InstallationId } from "@shared/installation-id";
import { MachineBuild, MachineName } from "@shared/machine-control";

export const LinkHelloSchema = Schema.Struct({ build: MachineBuild, installationId: InstallationId, machineName: MachineName });
const Id = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64)), Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/)));
const Channel = Schema.Literals(["rows", "seats", "status"]);
export const LinkFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("hello"), ...LinkHelloSchema.fields }),
  Schema.Struct({ type: Schema.Literal("request"), id: Id, channel: Channel, payload: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("response"), id: Id, channel: Channel, ok: Schema.Literal(true), payload: Schema.Json }),
  Schema.Struct({ type: Schema.Literal("response"), id: Id, channel: Channel, ok: Schema.Literal(false), error: Schema.Struct({ message: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(1024))) }) }),
  Schema.Struct({ type: Schema.Literal("event"), channel: Channel, payload: Schema.Json }),
]);
export type LinkFrame = typeof LinkFrame.Type;
const decode = Schema.decodeUnknownSync(LinkFrame, { onExcessProperty: "error" });
export const decodeLinkFrame = (input: unknown): LinkFrame => {
  const frame = decode(input);
  if ((frame.type === "request" || frame.type === "event" || (frame.type === "response" && frame.ok)) && !Object.hasOwn(frame, "payload")) throw new Error("link frame requires payload");
  return frame;
};
