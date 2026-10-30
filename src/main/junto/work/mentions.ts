// Where a seat, a task, an artifact or a page is mentioned, named against
// the canvas as it stands now (0.11, 02, L1). The rows come from
// `work_mentions` (`mention-backlinks.ts`); this file is the read rule the
// window's backlinks pane (`work/mention-ipc.ts`) and `junto artifact show`
// share, and it is pure: a canvas and rows in, a page out.

import { Effect } from "effect";
import { mailThreadOf, type MailMessageId } from "@shared/crew";
import { mailAuthorOf } from "@shared/mail-author";
import { mentionKey } from "@shared/mention";
import {
  MENTION_PAGE_DEFAULT,
  type MentionCursor,
  type MentionListInput,
  type MentionPage,
  type MentionedIn,
} from "@shared/mention-ipc";
import type { Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import type { ThreadPostAuthor } from "@shared/resource-ipc";
import { threadSubjectOf } from "@shared/thread-subject";
import type { WorkErrorBody } from "@shared/work-control";
import type { MentionAfter, MentionRow } from "./mention-backlinks";

export type MentionIpcPorts = {
  readonly topology: (canvasName: string) => Effect.Effect<Canvas, WorkErrorBody>;
  readonly read: (
    canvasName: string,
    key: string,
    limit: number,
    after?: MentionAfter,
  ) => Effect.Effect<ReadonlyArray<MentionRow>, WorkErrorBody>;
};

// ── the cursor ─────────────────────────────────────────────────────────────

const cursorOf = (row: MentionRow): MentionCursor =>
  Buffer.from(JSON.stringify([row.at_ms, row.message_id, row.node_id])).toString("base64url") as MentionCursor;

const badCursor: WorkErrorBody = {
  type: "InputError",
  message: "the page cursor is not one this list gave",
  details: { path: "page.before", retryable: false },
};

const afterOf = (cursor: MentionCursor): MentionAfter | undefined => {
  try {
    const read: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(read) || read.length !== 3) return undefined;
    const [atMs, messageId, nodeId] = read as [unknown, unknown, unknown];
    return Number.isSafeInteger(atMs) && typeof messageId === "string" && typeof nodeId === "string"
      ? { atMs: atMs as number, messageId, nodeId }
      : undefined;
  } catch {
    return undefined;
  }
};

// ── the entries ────────────────────────────────────────────────────────────

const parsedMetadata = (json: string | null): Readonly<Record<string, unknown>> | undefined => {
  if (json === null) return undefined;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Who wrote a row, named as the canvas names them now; undefined for a
 * malformed stamp. The rule a thread's posts are named by (resource-ipc.ts),
 * read from the stored row's actor and node.
 */
const authorOf = (canvas: Canvas, row: MentionRow, metadata: Readonly<Record<string, unknown>> | undefined): ThreadPostAuthor | undefined => {
  const nodeId = metadata?.senderNodeId;
  if (typeof nodeId !== "string" || nodeId === "") return undefined;
  const name = (id: string) => {
    const node = canvas.nodes.get(id as NodeId);
    const stamped = metadata?.senderName;
    return node === undefined ? (typeof stamped === "string" && stamped !== "" ? stamped : id) : titleOf(node);
  };
  const author = mailAuthorOf({ seatId: row.actor_seat_id as never, nodeId }, row.node_id);
  switch (author.kind) {
    case "operator":
      return { kind: "operator", name: "operator" };
    case "seat":
      return { kind: "seat", seatId: author.seatId, nodeId: author.nodeId as NodeId, name: name(author.nodeId) };
    case "automation":
      return { kind: "automation", nodeId: author.nodeId as unknown as NodeId, name: name(author.nodeId) };
    default:
      return undefined;
  }
};

/** A row as a backlink, named against the canvas now; undefined for a malformed stamp. `junto artifact show` reads it too. */
export const entryOf = (canvas: Canvas, row: MentionRow): MentionedIn | undefined => {
  const metadata = parsedMetadata(row.metadata_json);
  const author = authorOf(canvas, row, metadata);
  if (author === undefined) return undefined;
  const subject = threadSubjectOf({ metadata });
  return {
    messageId: row.message_id as MailMessageId,
    threadId: mailThreadOf({ messageId: row.message_id, metadata }) as MailMessageId,
    mailbox: row.node_id as NodeId,
    ...(subject === undefined ? {} : { subject }),
    author,
    at: row.at_ms,
  };
};

/**
 * One page of where `target` is mentioned, newest first. A row whose stamp
 * does not read is left out but still moves the cursor, so no page repeats.
 */
export const listMentions = (
  ports: MentionIpcPorts,
  input: typeof MentionListInput.Type,
): Effect.Effect<MentionPage, WorkErrorBody> =>
  Effect.gen(function* () {
    const before = input.page?.before;
    const after = before === undefined ? undefined : afterOf(before);
    if (before !== undefined && after === undefined) return yield* Effect.fail(badCursor);
    const limit = input.page?.limit ?? MENTION_PAGE_DEFAULT;
    // One more than the page says whether another follows.
    const rows = yield* ports.read(input.canvasName, mentionKey(input.target), limit + 1, after);
    const page = rows.slice(0, limit);
    const canvas = yield* ports.topology(input.canvasName);
    const entries = page.flatMap((row) => {
      const entry = entryOf(canvas, row);
      return entry === undefined ? [] : [entry];
    });
    const last = page.at(-1);
    return rows.length > limit && last !== undefined ? { entries, next: cursorOf(last) } : { entries };
  });
