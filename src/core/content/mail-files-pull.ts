/**
 * Operator mail files on the seat's machine: check ownership, pull any missing
 * file over the link from the machine that edits the canvas, keep it under
 * that mail in `content_refs`, and materialize it for delivery or seat reads.
 *
 * This module is the sole caller of `seatReachesOwnMail`. It pulls only refs
 * named by `operatorFilesOf` on a mail held in that seat's own mailbox, within
 * the attachment count, size and free-disk bounds, and never trusts a caller
 * to supply a digest, length or owner.
 */
import { Effect, Option } from "effect";
import { seatReachesOwnMail } from "@shared/content-pull";
import { operatorFilesOf } from "@shared/mail-threads";
import type { Canvas } from "@shared/model";
import { asNodeId } from "@shared/model/base";
import {
  OPERATOR_ATTACHMENT_MAX_BYTES,
  OPERATOR_ATTACHMENTS_MAX,
  attachmentDisplayName,
  attachmentMailLines,
} from "@shared/operator-attachments";
import type { ContentRef } from "@shared/wire/content-ref";
import type { Message } from "@shared/work-model";
import { admitContentWrite } from "../../node/content/disk-admission";
import { statContentForTransfer } from "../../node/content/transfer-local";
import { materializeContentObject } from "./agent-access";
import { BodyPuller } from "./body-puller";
import type { ContentOwner } from "./manifest";
import { operatorMailOwner, workHome } from "./operator-attachments";
import { ContentService, type ContentServiceShape } from "./service";

/** One operator file whose bytes are still on their way to this machine. */
export type SeatMailPendingFile = {
  readonly state: "pending";
  readonly name: string;
  readonly mediaType: string;
  readonly byteLength: number;
};

/** What a seat's `msg list` or `msg read` carries for a mail's operator files. */
export type SeatMailFilesView = {
  readonly files?: ReadonlyArray<string>;
  readonly filesPending?: ReadonlyArray<SeatMailPendingFile>;
};

const heldUnderOwner = (
  content: ContentServiceShape,
  owner: ContentOwner,
  ref: ContentRef,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const refs = yield* content.listRefs(ref.sha256).pipe(Effect.orElseSucceed(() => []));
    const owned = refs.some(
      (row) =>
        row.ref.byteLength === ref.byteLength &&
        row.owner.kind === owner.kind &&
        row.owner.canvasName === owner.canvasName &&
        row.owner.nodeId === owner.nodeId &&
        row.owner.recordId === owner.recordId,
    );
    if (!owned) return false;
    const opened = yield* content.openForRead(ref).pipe(Effect.orElseSucceed(() => undefined));
    return opened?.state === "verified";
  });

const boundedRefs = (message: Message): ReadonlyArray<ContentRef> => {
  const refs = operatorFilesOf(message);
  if (refs.length === 0 || refs.length > OPERATOR_ATTACHMENTS_MAX) return [];
  return refs.filter((ref) => ref.byteLength <= OPERATOR_ATTACHMENT_MAX_BYTES);
};

/**
 * Pull missing files for one operator mail under that mail's owner on this
 * machine. Fails closed if the seat does not live on this machine, or if a
 * missing file would leave this machine below its free-disk floor.
 */
const pullMailRefs = (input: {
  readonly content: ContentServiceShape;
  readonly canvasName: string;
  readonly canvas: Canvas;
  readonly nodeId: string;
  readonly messageId: string;
  readonly refs: ReadonlyArray<ContentRef>;
  readonly freeBytes?: number;
}): Effect.Effect<boolean, never, BodyPuller> =>
  Effect.gen(function* () {
    const puller = yield* BodyPuller;
    if (puller.placement === undefined) return false;
    const info = yield* puller.placement(input.canvasName).pipe(Effect.orElseSucceed(() => undefined));
    if (info === undefined) return false;
    const reached = seatReachesOwnMail(input.canvasName, input.canvas, asNodeId(input.nodeId), info.placement, info.self);
    if (reached === undefined) return false;
    const owner = {
      kind: "message" as const,
      canvasName: input.canvasName,
      nodeId: input.nodeId,
      recordId: input.messageId,
    };
    let allPulled = true;
    for (const ref of input.refs) {
      const stat = statContentForTransfer(input.content.root, ref);
      if (stat.state !== "verified") {
        const room = yield* Effect.try(() =>
          admitContentWrite({
            root: input.content.root,
            needBytes: ref.byteLength,
            ...(input.freeBytes === undefined ? {} : { freeBytes: input.freeBytes }),
          }),
        ).pipe(Effect.orElseSucceed(() => ({ ok: false as const })));
        if (!room.ok) {
          allPulled = false;
          continue;
        }
      }
      const pulled = yield* puller.pull({ ref, owner, reached }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!pulled) allPulled = false;
    }
    return allPulled;
  });

const materializeOne = (
  content: ContentServiceShape,
  input: { readonly canvasName: string; readonly nodeId: string; readonly messageId: string; readonly ref: ContentRef },
): Effect.Effect<string | undefined> =>
  Effect.tryPromise(() =>
    materializeContentObject({
      contentRoot: content.root,
      workHome: workHome(),
      canvasName: input.canvasName,
      targetNodeId: input.nodeId,
      taskId: `mail-${input.messageId}`,
      ref: input.ref,
    }),
  ).pipe(
    Effect.map(({ path }) => attachmentMailLines([input.ref], () => path)[0]),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Operator files on a mail as a seat's `msg list` or `msg read` sees them:
 * ready files materialize into `files`, and any file not yet held triggers a
 * background pull and appears in `filesPending` instead of being dropped.
 */
export const seatMailFiles = (input: {
  readonly canvasName: string;
  readonly canvas: Canvas;
  readonly nodeId: string;
  readonly message: Message;
  readonly freeBytes?: number;
}): Effect.Effect<SeatMailFilesView | undefined, never, ContentService> =>
  Effect.gen(function* () {
    const refs = boundedRefs(input.message);
    if (refs.length === 0) return undefined;
    const content = yield* ContentService;
    const owner = operatorMailOwner(input.canvasName, input.nodeId, input.message.messageId);
    const readyLines: string[] = [];
    const missing: ContentRef[] = [];
    for (const ref of refs) {
      const held = yield* heldUnderOwner(content, owner, ref);
      if (!held) {
        missing.push(ref);
        continue;
      }
      const line = yield* materializeOne(content, {
        canvasName: input.canvasName,
        nodeId: input.nodeId,
        messageId: input.message.messageId,
        ref,
      });
      if (line === undefined || line.endsWith(": ")) missing.push(ref);
      else readyLines.push(line);
    }
    if (missing.length > 0) {
      const puller = yield* Effect.serviceOption(BodyPuller);
      if (Option.isSome(puller)) {
        yield* pullMailRefs({
          content,
          canvasName: input.canvasName,
          canvas: input.canvas,
          nodeId: input.nodeId,
          messageId: input.message.messageId,
          refs: missing,
          ...(input.freeBytes === undefined ? {} : { freeBytes: input.freeBytes }),
        }).pipe(Effect.provideService(BodyPuller, puller.value), Effect.ignore, Effect.forkDetach, Effect.asVoid);
      }
    }
    const filesPending: ReadonlyArray<SeatMailPendingFile> = missing.map((ref) => ({
      state: "pending",
      name: attachmentDisplayName(ref),
      mediaType: ref.mediaType,
      byteLength: ref.byteLength,
    }));
    return {
      ...(readyLines.length === 0 ? {} : { files: readyLines }),
      ...(filesPending.length === 0 ? {} : { filesPending }),
    };
  });

/**
 * Delivery's check for an operator mail's files: returns all `Attached:` lines
 * only once every file is verified and kept under the mail on this machine.
 * Otherwise starts a background pull for the missing files and returns
 * undefined so delivery holds until every file is whole; calls `onReady` once
 * a background pull finishes bringing every missing file in.
 */
export const deliverOperatorAttachmentLines = (input: {
  readonly content: ContentServiceShape;
  readonly canvasName: string;
  readonly canvas: Canvas | undefined;
  readonly nodeId: string;
  readonly message: Message;
  readonly onReady?: () => void;
  readonly freeBytes?: number;
}): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.gen(function* () {
    const refs = boundedRefs(input.message);
    if (refs.length === 0) return [];
    const owner = operatorMailOwner(input.canvasName, input.nodeId, input.message.messageId);
    const missing: ContentRef[] = [];
    for (const ref of refs) {
      if (!(yield* heldUnderOwner(input.content, owner, ref))) missing.push(ref);
    }
    if (missing.length > 0) {
      const puller = yield* Effect.serviceOption(BodyPuller);
      if (Option.isSome(puller) && input.canvas !== undefined) {
        yield* pullMailRefs({
          content: input.content,
          canvasName: input.canvasName,
          canvas: input.canvas,
          nodeId: input.nodeId,
          messageId: input.message.messageId,
          refs: missing,
          ...(input.freeBytes === undefined ? {} : { freeBytes: input.freeBytes }),
        }).pipe(
          Effect.provideService(BodyPuller, puller.value),
          Effect.tap((done) => (done ? Effect.sync(() => input.onReady?.()) : Effect.void)),
          Effect.ignore,
          Effect.forkDetach,
          Effect.asVoid,
        );
      }
      return undefined;
    }
    const lines: string[] = [];
    for (const ref of refs) {
      const line = yield* materializeOne(input.content, {
        canvasName: input.canvasName,
        nodeId: input.nodeId,
        messageId: input.message.messageId,
        ref,
      });
      if (line === undefined || line.endsWith(": ")) return undefined;
      lines.push(line);
    }
    return lines;
  });
