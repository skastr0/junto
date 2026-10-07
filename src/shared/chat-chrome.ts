import { Schema } from "effect";

/** Live ACP attention for chrome, independent of transcript and view mounts. */
export const ChatChromeState = Schema.Struct({
  agentKey: Schema.String,
  sessionLive: Schema.Boolean,
  permissionPending: Schema.Boolean,
});
export type ChatChromeState = typeof ChatChromeState.Type;

export const ChatChromeSnapshot = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  states: Schema.Array(ChatChromeState),
});
export type ChatChromeSnapshot = typeof ChatChromeSnapshot.Type;

export const ChatChromeChanged = Schema.Struct({
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: ChatChromeState,
});
export type ChatChromeChanged = typeof ChatChromeChanged.Type;
