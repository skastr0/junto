/**
 * Mentions: the wire module (`./wire/mention.ts`), one definition for the
 * desktop and the phone. The wire reads a node's kind as a string; here every
 * mentionable kind is held to the canvas's own `NodeKind`, so a kind renamed
 * on the canvas fails to compile until mentions follow.
 */
import type { NodeKind } from "./model/kinds";
import type { MentionableNodeKind } from "./wire/mention";

export * from "./wire/mention";

type Holds<T extends true> = T;
/** Compiles only while every mentionable kind is a real node kind. */
export type MentionableKindsAreNodeKinds = Holds<MentionableNodeKind extends NodeKind ? true : false>;
