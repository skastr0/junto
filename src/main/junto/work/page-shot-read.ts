/**
 * The read of a page box comment's shot on the machine that holds it (plan
 * 06, B7, remote-security's ruling, condition 5). The row names the shot
 * (`pageShotOf`, never raw metadata); naming is not holding, so the bytes
 * are served only while a comment in that thread on that page holds its
 * claim. The bytes are judged again from the store's own file before
 * anything shows them: digest, size, a PNG header, 2 MiB and 4096 pixels.
 *
 * Reach is the caller's: the operator reaches every node. A seat's read
 * goes through its own reach check before it asks.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { mailThreadOf } from "@shared/crew";
import { PAGE_SHOT_MAX_BYTES, pageShotRefusal } from "@shared/page-shot";
import { pageShotOf } from "@shared/thread-subject";
import type { ContentRef } from "@shared/wire/content-ref";
import { ContentService } from "../content/service";
import { WorkService } from "./service";

export type PageShotAt = {
  readonly canvasName: string;
  /** The page node the comment is held at. */
  readonly nodeId: string;
  /** The comment, or a reply in its thread. */
  readonly messageId: string;
};

export type PageShotRead =
  | { readonly ok: true; readonly ref: ContentRef; readonly bytes: Buffer }
  /** No such comment, or it names no shot. */
  | { readonly ok: false; readonly reason: "not-named" }
  /** The comment names a shot nobody in its thread holds, or the store has no good copy. */
  | { readonly ok: false; readonly reason: "missing" };

const notNamed = { ok: false, reason: "not-named" } as const;
const missing = { ok: false, reason: "missing" } as const;

export const readPageShot = (at: PageShotAt): Effect.Effect<PageShotRead, never, WorkService | ContentService> =>
  Effect.gen(function* () {
    const rows = yield* Effect.flatMap(WorkService, (work) => work.readMailbox(at.canvasName, at.nodeId)).pipe(
      Effect.orElseSucceed(() => []),
    );
    const row = rows.find((message) => message.messageId === at.messageId);
    const ref = row === undefined ? undefined : pageShotOf(row);
    if (row === undefined || ref === undefined) return notNamed;
    // A reply copies its root's subject: the claim is held by a comment in the same thread.
    const thread = mailThreadOf(row);
    const inThread = new Set(rows.filter((message) => mailThreadOf(message) === thread).map((message) => message.messageId));
    const content = yield* ContentService;
    const owners = yield* content.listRefs(ref.sha256).pipe(Effect.orElseSucceed(() => []));
    const held = owners.some(
      (owned) =>
        owned.ref.byteLength === ref.byteLength &&
        owned.owner.kind === "message" &&
        owned.owner.canvasName === at.canvasName &&
        owned.owner.nodeId === at.nodeId &&
        inThread.has(owned.owner.recordId),
    );
    if (!held || ref.byteLength > PAGE_SHOT_MAX_BYTES) return missing;
    const opened = yield* content.openForRead(ref).pipe(Effect.orElseSucceed(() => undefined));
    if (opened?.state !== "verified") return missing;
    const bytes = yield* Effect.tryPromise(() => readFile(opened.path)).pipe(Effect.orElseSucceed(() => undefined));
    if (
      bytes === undefined ||
      bytes.byteLength !== ref.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== ref.sha256 ||
      pageShotRefusal(bytes) !== undefined
    ) {
      return missing;
    }
    return { ok: true, ref, bytes };
  });
