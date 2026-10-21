/**
 * A resource body pulled from the machine that edits its canvas
 * (src/shared/content-pull.ts).
 *
 * Both halves live here. The editing machine answers the link's `content`
 * channel: one piece of one object it holds verified, admitted by
 * `admitContentPull`. The machine that needs the body asks for it piece by
 * piece over that link and takes each piece into its own store from where its
 * partial ends (`receiveContentTransfer`), so a cut link resumes and the
 * object is published only once all of it matches its sha256. Then it binds
 * the body to its own owner, so its store keeps it.
 *
 * What crosses, and what is logged, is the digest, the size and a fixed
 * reason: never bytes, never a store path (a store error names one).
 *
 * The serve is as wide as artifact entitlement: every machine linked for a
 * canvas holds every resource fact for it, digests included
 * (docs/plans/0.10/02-universal-resources.md). If that entitlement ever
 * narrows below "linked for the canvas", this serve narrows in the same change.
 */
import { Effect, Schema } from "effect";
import {
  CONTENT_PULL_MAX_CONCURRENT,
  ContentPullPiece,
  ContentPullRefusal,
  ContentPullRefused,
  ContentPullRequest,
  admitContentPull,
  contentPullPieceLength,
  contentPullRefusal,
  contentPullRefused,
  type ContentPullFacts,
  type PullableOwnerKind,
  type ResourceReached,
} from "@shared/content-pull";
import type { InstallationId } from "@shared/installation-id";
import type { ContentRef } from "@shared/wire/content-ref";
import type { LinkChannelHandler } from "../link/types";
import { readContentObjectRange } from "./store";
import { receiveContentTransfer, statContentForTransfer } from "./transfer-local";

/** The editing machine could not read a body it should hold: the asker tries again later. */
export class ContentServeFailed extends Schema.TaggedError<ContentServeFailed>()("ContentServeFailed", {
  sha256: Schema.String,
  byteLength: Schema.Number,
  message: Schema.String,
}) {}

/** A pull that did not finish for a reason of its own, not a refusal: worth asking again. */
export class ContentPullFailed extends Schema.TaggedError<ContentPullFailed>()("ContentPullFailed", {
  sha256: Schema.String,
  byteLength: Schema.Number,
  message: Schema.String,
}) {}

class NoContentEvents extends Schema.TaggedError<NoContentEvents>()("NoContentEvents", { message: Schema.String }) {}

const decodeRequest = Schema.decodeUnknownSync(ContentPullRequest, { onExcessProperty: "error" });
const decodePiece = Schema.decodeUnknownSync(ContentPullPiece, { onExcessProperty: "error" });

export type ContentServeDeps = {
  /** This machine's content store. */
  readonly root: string;
  /** Whether this machine edits the canvas, and whether that machine is linked for it. */
  readonly canvas: (canvasName: string, peer: InstallationId) => Effect.Effect<{ readonly edits: boolean; readonly peerLinked: boolean }, unknown>;
  /** The manifest's word that the object is here and verified, at that length. */
  readonly verified: (ref: Pick<ContentRef, "sha256" | "byteLength">) => Effect.Effect<boolean, unknown>;
  /**
   * Who holds a ref to the object, read from this machine's store, never from
   * the request; an owner entitled by row says whether a row naming these
   * bytes for it crossed to the asking machine, judged now.
   */
  readonly owners: (sha256: string, canvasName: string, peer: InstallationId) => Effect.Effect<ContentPullFacts["owners"], unknown>;
};

/** The editing machine's half: the link's `content` channel. */
export const makeContentChannel = (deps: ContentServeDeps): LinkChannelHandler => ({
  decodeRequest,
  decodeResponse: decodePiece,
  decodeEvent: () => {
    throw new NoContentEvents({ message: "the content channel carries no events" });
  },
  failureSchema: ContentPullRefusal as unknown as Schema.Codec<unknown, unknown>,
  handleRequest: (context, payload) => {
    const request = payload as ContentPullRequest;
    const unreadable = () => new ContentServeFailed({ sha256: request.sha256, byteLength: request.byteLength, message: "the body could not be read here; ask again later" });
    return Effect.gen(function* () {
      const canvas = yield* deps.canvas(request.canvasName, context.peer.installationId);
      const heldVerified = canvas.edits && canvas.peerLinked ? yield* deps.verified(request) : false;
      const owners = heldVerified ? yield* deps.owners(request.sha256, request.canvasName, context.peer.installationId) : [];
      const reason = admitContentPull(request, { ...canvas, heldVerified, owners });
      if (reason !== undefined) return yield* Effect.fail(contentPullRefusal(reason));
      const length = contentPullPieceLength(request.byteLength, request.offset);
      const bytes = length === 0 ? new Uint8Array(0) : readContentObjectRange(deps.root, request, request.offset, length);
      if (bytes === undefined) return yield* Effect.fail(unreadable());
      return { offset: request.offset, bytes: Buffer.from(bytes).toString("base64") } satisfies ContentPullPiece;
    }).pipe(
      // A refusal crosses typed; anything else crosses as fixed words, never its own message.
      Effect.mapError((cause) => (cause instanceof ContentPullRefusal ? cause : unreadable())),
      Effect.tapError((cause) =>
        Effect.logInfo("a body was not served").pipe(
          Effect.annotateLogs({ area: "content-pull", sha256: request.sha256, byteLength: request.byteLength, reason: cause instanceof ContentPullRefusal ? cause.reason : "unreadable" }),
        ),
      ),
    );
  },
});

/** The owner a pulled body is kept under on the asking machine. */
export type PulledOwner = { readonly kind: PullableOwnerKind; readonly canvasName: string; readonly nodeId: string; readonly recordId: string };

export type ContentPullDeps = {
  /** This machine's content store. */
  readonly root: string;
  /** Ask the editing machine for one piece; its refusal comes back typed. */
  readonly ask: (request: ContentPullRequest) => Effect.Effect<unknown, unknown>;
  /** Keep the published object under its owner in this machine's manifest. */
  readonly keep: (ref: ContentRef, owner: PulledOwner) => Effect.Effect<void, unknown>;
  /**
   * Run the transfer of one object once for every caller at a time
   * (`makeContentPulls`); each caller still keeps it under its own owner.
   */
  readonly once?: <E>(ref: ContentRef, transfer: Effect.Effect<void, E>) => Effect.Effect<void, E>;
};

/**
 * Pull one body into this machine's store and keep it under `owner`. The
 * resource must be in reach of who asked; `reached` is the proof.
 */
export const pullContent = (deps: ContentPullDeps, input: { readonly ref: ContentRef; readonly owner: PulledOwner; readonly reached: ResourceReached }) => {
  const { ref, owner, reached } = input;
  const failed = (message: string) => new ContentPullFailed({ sha256: ref.sha256, byteLength: ref.byteLength, message });
  return Effect.gen(function* () {
    if (reached.canvasName !== owner.canvasName || reached.resourceId !== owner.nodeId) {
      return yield* Effect.fail(failed("the body is kept under the resource that was reached, and no other"));
    }
    const transfer = Effect.gen(function* () {
      const take = (source: Uint8Array, offset: number) =>
        Effect.tryPromise({
          // The store publishes only a whole object that matches its digest, and drops a wrong one.
          try: () => receiveContentTransfer({ root: deps.root, ref, source, expectedOffset: offset }),
          catch: () => failed("the body could not be taken into this machine's store, or did not match its digest"),
        });
      for (let cleared = false; ; ) {
        const here = statContentForTransfer(deps.root, ref);
        if (here.state === "verified") break;
        if (here.state === "corrupt") {
          // Taking nothing drops a damaged partial; a damaged object here stays a failure.
          if (cleared) return yield* Effect.fail(failed("a damaged copy of the body is in this machine's store"));
          cleared = true;
          yield* take(new Uint8Array(0), 0).pipe(Effect.ignore);
          continue;
        }
        const offset = here.state === "partial" ? here.partialBytes : 0;
        if (offset === ref.byteLength && ref.byteLength > 0) {
          // Every byte arrived before a stop: publish it, nothing more to ask for.
          yield* take(new Uint8Array(0), offset);
          continue;
        }
        const answer = yield* deps.ask({ canvasName: owner.canvasName, sha256: ref.sha256, byteLength: ref.byteLength, offset });
        const piece = yield* Effect.try({ try: () => decodePiece(answer), catch: () => failed("the editing machine answered something else") });
        const bytes = Buffer.from(piece.bytes, "base64");
        if (piece.offset !== offset || bytes.length !== contentPullPieceLength(ref.byteLength, offset)) {
          return yield* Effect.fail(failed("the editing machine answered another piece"));
        }
        yield* take(bytes, offset);
      }
    });
    yield* (deps.once === undefined ? transfer : deps.once(ref, transfer));
    yield* deps.keep(ref, owner).pipe(Effect.mapError(() => failed("the body could not be kept here")));
  }).pipe(
    Effect.mapError((cause) => {
      if (cause instanceof ContentPullRefused || cause instanceof ContentPullFailed) return cause;
      // The link carries the editing machine's refusal as the failure's detail, decoded by its schema.
      const detail = (cause as { readonly detail?: unknown } | null)?.detail;
      return detail instanceof ContentPullRefusal ? contentPullRefused(detail, ref) : failed("the link to the editing machine failed");
    }),
    Effect.tapError((cause) =>
      Effect.logInfo("a body was not pulled").pipe(
        Effect.annotateLogs({ area: "content-pull", sha256: ref.sha256, byteLength: ref.byteLength, reason: cause instanceof ContentPullRefused ? cause.reason : "failed" }),
      ),
    ),
  );
};

/**
 * The transfers in flight on this machine: one per object, since the store's
 * partial is keyed by its digest alone, and at most a few at once, under the
 * link's requests in flight. A second ask for an object joins the first's
 * transfer; only the bytes are shared, never the keeping.
 */
export const makeContentPulls = () => {
  const inFlight = new Map<string, Promise<unknown>>();
  const queue: Array<() => void> = [];
  let running = 0;
  const slot = () =>
    new Promise<void>((resolve) => {
      if (running < CONTENT_PULL_MAX_CONCURRENT) {
        running += 1;
        resolve();
      } else queue.push(() => { running += 1; resolve(); });
    });
  const release = () => {
    running -= 1;
    queue.shift()?.();
  };
  return {
    pull: <T>(ref: ContentRef, run: () => Promise<T>): Promise<T> => {
      const known = inFlight.get(ref.sha256);
      if (known !== undefined) return known as Promise<T>;
      const started = slot().then(() => run().finally(release)).finally(() => inFlight.delete(ref.sha256));
      inFlight.set(ref.sha256, started);
      return started;
    },
    inFlight: (): number => inFlight.size,
  };
};
