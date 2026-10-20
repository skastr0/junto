import { open } from "node:fs/promises";
import { Effect, Option } from "effect";
import type { ContentStageArgs } from "@shared/content-stage";
import { resolveJuntoHome } from "@shared/junto-home";
import {
  OPERATOR_ATTACHMENT_MAX_BYTES,
  OPERATOR_ATTACHMENTS_MAX,
  attachmentMailLines,
  type OperatorContentPutResult,
} from "@shared/operator-attachments";
import { ATTACHMENT_HEAD_BYTES, attachmentMediaType, attachmentName } from "@shared/preview-bytes";
import type { ContentRef } from "@shared/wire/content-ref";
import { WORK_HOME_ENV, workControlDir } from "@shared/work-control";
import { operatorActorRef } from "@shared/work-reference";
import { materializeContentObject } from "./agent-access";
import type { ContentOwner } from "./manifest";
import { ContentService, type ContentServiceShape } from "./service";
import { claimStagedContent, contentStagerFor, type ContentStageSeat } from "./stage";

/**
 * The operator's files on their way to a seat (`@shared/operator-attachments`).
 *
 * The desktop stages the bytes as the operator, through the staging a seat
 * uses. A mail that names them claims each one for itself, which reads its
 * type from the stored bytes and its name from what main recorded, never
 * from the caller's copy. Delivery copies each file into the work home under
 * the receiving seat and the mail, and the mail lists that path.
 */

/** The operator, as the seat that staged its own uploads on a canvas. */
const operatorStager = (canvasName: string): ContentStageSeat => ({
  canvasName,
  nodeId: operatorActorRef(canvasName).nodeId,
});

const MAX_MB = OPERATOR_ATTACHMENT_MAX_BYTES / (1024 * 1024);

/** One piece of an operator upload, staged in the Mac content store. */
export const putOperatorContent = (
  canvasName: string,
  args: ContentStageArgs,
): Effect.Effect<OperatorContentPutResult> =>
  Effect.gen(function* () {
    const content = yield* Effect.serviceOption(ContentService);
    if (Option.isNone(content)) return { ok: false, message: "The content store is unavailable." } as const;
    const staged = yield* Effect.result(contentStagerFor(content.value).stage(operatorStager(canvasName), args));
    if (staged._tag === "Failure") return { ok: false, message: staged.failure.message } as const;
    const result = staged.success;
    const byteLength = "ref" in result ? result.ref.byteLength : result.byteLength;
    if (byteLength > OPERATOR_ATTACHMENT_MAX_BYTES) {
      return { ok: false, message: `A file is at most ${MAX_MB} MB.` } as const;
    }
    return { ok: true, result } as const;
  });

/** Where a mail's files are held in the store: under the seat that receives it, by the mail. */
export const operatorMailOwner = (canvasName: string, nodeId: string, messageId: string): ContentOwner => ({
  kind: "message",
  canvasName,
  nodeId,
  recordId: messageId,
});

export type OperatorAttachmentRefusal = { readonly message: string };

const readHead = async (path: string, limit: number): Promise<Buffer> => {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(limit);
    let filled = 0;
    while (filled < limit) {
      const { bytesRead } = await handle.read(head, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return head.subarray(0, filled);
  } finally {
    await handle.close();
  }
};

/**
 * Take the files the operator staged for one mail and hold them under
 * `owner`, in order, the same file once. Fails with the first refused and
 * why; whatever was taken is let go again, so a refused mail keeps nothing.
 */
export const claimOperatorAttachments = (
  content: ContentServiceShape,
  canvasName: string,
  refs: ReadonlyArray<Pick<ContentRef, "sha256" | "byteLength">>,
  owner: ContentOwner,
): Effect.Effect<ReadonlyArray<ContentRef>, OperatorAttachmentRefusal> => {
  if (refs.length > OPERATOR_ATTACHMENTS_MAX) {
    return Effect.fail({ message: `A mail carries at most ${OPERATOR_ATTACHMENTS_MAX} files.` });
  }
  const held = new Map<string, ContentRef>();
  return Effect.forEach(refs, (identity) =>
    Effect.gen(function* () {
      const key = `${identity.sha256}:${identity.byteLength}`;
      const known = held.get(key);
      if (known !== undefined) return [];
      if (identity.byteLength > OPERATOR_ATTACHMENT_MAX_BYTES) {
        return yield* Effect.fail({ message: `A file is at most ${MAX_MB} MB.` });
      }
      const row = yield* claimStagedContent(content, { ...operatorStager(canvasName), ref: identity, owner }).pipe(
        Effect.mapError(() => ({ message: "A file was not uploaded, or it was already sent. Attach it again." })),
      );
      const name = attachmentName(row.ref.displayName ?? "") || "file";
      const opened = yield* content.openForRead(row.ref).pipe(Effect.orElseSucceed(() => undefined));
      if (opened?.state !== "verified") return yield* Effect.fail({ message: `${name} is not in the store.` });
      const head = yield* Effect.tryPromise({
        try: () => readHead(opened.path, Math.min(row.ref.byteLength, ATTACHMENT_HEAD_BYTES)),
        catch: () => ({ message: `${name} could not be read from the store.` }),
      });
      const ref = { ...row.ref, mediaType: attachmentMediaType(name, head), displayName: name } as ContentRef;
      held.set(key, ref);
      return [ref];
    }),
  ).pipe(
    Effect.map((taken) => taken.flat()),
    Effect.tapError(() => content.releaseOwner(owner).pipe(Effect.ignore)),
  );
};

/** The work home seats on this Mac read materialized files from. */
const workHome = (): string => process.env[WORK_HOME_ENV]?.trim() || workControlDir(resolveJuntoHome());

/**
 * The delivered mail's lines for its files: each copied into the work home
 * under the receiving seat and the mail, so the seat opens it by an absolute
 * path that outlives the store's own garbage collection.
 */
export const operatorAttachmentLines = (
  content: ContentServiceShape,
  input: {
    readonly canvasName: string;
    readonly nodeId: string;
    readonly messageId: string;
    readonly refs: ReadonlyArray<ContentRef>;
  },
): Effect.Effect<ReadonlyArray<string>, OperatorAttachmentRefusal> =>
  Effect.forEach(input.refs, (ref) =>
    Effect.tryPromise({
      try: () =>
        materializeContentObject({
          contentRoot: content.root,
          workHome: workHome(),
          canvasName: input.canvasName,
          targetNodeId: input.nodeId,
          taskId: `mail-${input.messageId}`,
          ref,
        }),
      catch: () => ({ message: `${attachmentName(ref.displayName ?? "") || "A file"} could not be delivered.` }),
    }).pipe(Effect.map(({ path }) => ({ ref, path }))),
  ).pipe(
    Effect.map((placed) => {
      const paths = new Map(placed.map(({ ref, path }) => [`${ref.sha256}:${ref.byteLength}`, path]));
      return attachmentMailLines(input.refs, (ref) => paths.get(`${ref.sha256}:${ref.byteLength}`) ?? "");
    }),
  );
