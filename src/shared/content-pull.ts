/**
 * A resource body pulled on demand from the machine that edits its canvas
 * (docs/plans/0.10/02-universal-resources.md, Contracts: bytes move on demand).
 *
 * A fact names a body by ContentRef; the bytes stay on the editing machine
 * until a machine that needs them asks. It asks over the link, one piece at
 * a time, and takes each piece into its own store from where its partial
 * ends, so a cut link resumes. The editing machine serves only an object it
 * holds verified, and only under an owner of a pullable kind on a canvas the
 * asker is linked for. The asker publishes the object only once the whole of
 * it matches its sha256, so no peer makes it keep a wrong body.
 *
 * A refusal says what the asker does next. It crosses as its reason alone;
 * each side logs it with the digest, the size and the reason, never bytes or
 * a store path.
 */
import { Schema } from "effect";
import { RESOURCE_KINDS, reaches, type ReachCanvas } from "./region-reach";
import type { NodeId } from "./model/base";
import { WorkCanvasName } from "./work-reference";
import { ContentByteLength, ContentSha256 } from "./wire/content-ref";

/** One piece's bytes: as base64 with its envelope, well inside one 1 MiB link frame. */
export const CONTENT_PULL_PIECE_BYTES = 512 * 1024;

/** Pulls one machine runs at once, well inside the link's 32 requests in flight. */
export const CONTENT_PULL_MAX_CONCURRENT = 4;

/** The owners whose bodies a peer may pull: an artifact's body, a page comment's shot. */
export const PULLABLE_OWNER_KINDS = ["artifact", "message"] as const;
export type PullableOwnerKind = (typeof PULLABLE_OWNER_KINDS)[number];

/**
 * What entitles a linked machine to an owner's bytes, by kind. Total, so a
 * kind made pullable fails tsc until its entitlement is named here.
 * - `linked`: every machine linked for the canvas holds every resource fact of
 *   it, digests included (02), so the link is the entitlement.
 * - `row`: only a row that told the asker of these bytes, and crossed to it by
 *   the exchange's own rule, entitles it: a comment's shot is served to a
 *   machine the comment, or a notice of it, reached.
 */
export const OWNER_ENTITLEMENT: { readonly [K in PullableOwnerKind]: "linked" | "row" } = {
  artifact: "linked",
  message: "row",
};
export const isPullableOwnerKind = (kind: string): kind is PullableOwnerKind =>
  (PULLABLE_OWNER_KINDS as ReadonlyArray<string>).includes(kind);

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)));
const Bytes = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0)), Schema.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)));

/** Ask for the piece of one object that starts at `offset`. */
export const ContentPullRequest = Schema.Struct({
  canvasName: WorkCanvasName,
  sha256: ContentSha256,
  byteLength: ContentByteLength,
  offset: Bytes,
});
export type ContentPullRequest = typeof ContentPullRequest.Type;

const BASE64_PIECE_CHARS = Math.ceil(CONTENT_PULL_PIECE_BYTES / 3) * 4;

/** One piece, from `offset`; the last piece of an object is shorter. */
export const ContentPullPiece = Schema.Struct({
  offset: Bytes,
  bytes: Schema.String.pipe(Schema.check(Schema.isMaxLength(BASE64_PIECE_CHARS)), Schema.check(Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/))),
});
export type ContentPullPiece = typeof ContentPullPiece.Type;

/**
 * Why the editing machine would not serve a piece, by what the asker does next:
 * - `not-editor`: this machine does not edit the canvas; ask the one that does.
 * - `not-held`: nothing to serve to this machine for this canvas, the body or
 *   its owner is not there or the asker is not linked for the canvas; stop
 *   until a new fact names the body.
 * - `range`: the piece is outside the object; read the own partial and ask again from it.
 */
export const ContentPullReason = Schema.Literals(["not-editor", "not-held", "range"]);
export type ContentPullReason = typeof ContentPullReason.Type;

/**
 * The refusal as it crosses the link: the reason and fixed words. The link's
 * failure encoder redacts any 64-hex string, so the digest stays home; the
 * asker knows what it asked for.
 */
export class ContentPullRefusal extends Schema.TaggedError<ContentPullRefusal>()("ContentPullRefusal", {
  reason: ContentPullReason,
  message: Schema.String,
}) {}

/** The refusal on the asking machine, about the object it asked for. */
export class ContentPullRefused extends Schema.TaggedError<ContentPullRefused>()("ContentPullRefused", {
  reason: ContentPullReason,
  sha256: Sha256,
  byteLength: Bytes,
  message: Schema.String,
}) {}

const SENTENCE: Record<ContentPullReason, string> = {
  "not-editor": "the machine asked does not edit this canvas",
  "not-held": "the machine that edits this canvas holds no body by that digest for this machine",
  range: "the piece asked for is outside the object",
};

export const contentPullRefusal = (reason: ContentPullReason): ContentPullRefusal =>
  new ContentPullRefusal({ reason, message: SENTENCE[reason] });

export const contentPullRefused = (refusal: ContentPullRefusal, ref: { readonly sha256: string; readonly byteLength: number }): ContentPullRefused =>
  new ContentPullRefused({ reason: refusal.reason, sha256: ref.sha256, byteLength: ref.byteLength, message: SENTENCE[refusal.reason] });

/** What the editing machine knows when a piece is asked for. */
export type ContentPullFacts = {
  /** This machine edits the canvas named. */
  readonly edits: boolean;
  /** The asking machine is linked for that canvas. */
  readonly peerLinked: boolean;
  /** The object is in this machine's store, verified, at that length. */
  readonly heldVerified: boolean;
  /**
   * Who holds a ref to the object, by owner kind and canvas, as the store
   * holds them. `rowEntitled` is set for a kind entitled by row: whether a row
   * naming these bytes for that owner crossed to the asking machine.
   */
  readonly owners: ReadonlyArray<{ readonly kind: string; readonly canvasName: string; readonly rowEntitled?: boolean }>;
};

/** Serve the piece, or the one reason not to. Pure. */
export const admitContentPull = (request: ContentPullRequest, facts: ContentPullFacts): ContentPullReason | undefined => {
  if (!facts.edits) return "not-editor";
  const shared = facts.owners.some((owner) =>
    isPullableOwnerKind(owner.kind) &&
    owner.canvasName === request.canvasName &&
    (OWNER_ENTITLEMENT[owner.kind] === "linked" || owner.rowEntitled === true));
  if (!facts.peerLinked || !facts.heldVerified || !shared) return "not-held";
  const inside = request.byteLength === 0 ? request.offset === 0 : request.offset < request.byteLength;
  return inside ? undefined : "range";
};

/** The bytes of the piece that starts at `offset`. */
export const contentPullPieceLength = (byteLength: number, offset: number): number =>
  Math.max(0, Math.min(CONTENT_PULL_PIECE_BYTES, byteLength - offset));

declare const reachBrand: unique symbol;

/**
 * The asker's word that the resource whose body it pulls is in reach of who
 * asked: minted only by the checks below, so a pull cannot be written without one.
 */
export type ResourceReached = { readonly canvasName: string; readonly resourceId: NodeId; readonly [reachBrand]: true };

/**
 * The nodes whose bytes a seat may pull: the resource nodes, and a page for
 * its box comments' shots (a page is commentable, not a resource). Closed: a
 * kind joins here, in the one mint below, or a seat never reaches it.
 */
export const REACHABLE_PULL_KINDS = [...RESOURCE_KINDS, "page"] as const;
const isReachablePullKind = (kind: string): boolean => (REACHABLE_PULL_KINDS as ReadonlyArray<string>).includes(kind);

/**
 * A seat asks: the node must be one of those kinds and in its reach
 * (`reaches`, region-reach.ts). The one mint of a seat's ResourceReached.
 */
export const seatReachesResource = (
  canvasName: string,
  canvas: ReachCanvas,
  seatId: NodeId,
  resourceId: NodeId,
): ResourceReached | undefined => {
  const node = canvas.nodes.get(resourceId);
  return canvas.nodes.get(seatId)?.kind === "agent" && node !== undefined && isReachablePullKind(node.kind) && reaches(canvas, seatId, resourceId)
    ? ({ canvasName, resourceId } as ResourceReached)
    : undefined;
};

/** The operator asks: every resource of a canvas is in the operator's reach. */
export const operatorReachesResource = (canvasName: string, resourceId: NodeId): ResourceReached =>
  ({ canvasName, resourceId }) as ResourceReached;
