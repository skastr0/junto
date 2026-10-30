/**
 * What the window reads through the work core (junto/ipc.ts): a canvas
 * topology for the resource, mention and link ports, a node's comments, a
 * node's mentions, and the window's own work pages. A topology answer is the
 * canvas itself, which crosses the port as plain data (maps and arrays),
 * never a service; the page answers keep the repository's shapes.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Canvas } from "@shared/model";
import type { Message } from "@shared/work-model";
import { WorkAttentionQuery, WorkItemQuery, WorkSinkQuery } from "@shared/work-sinks";
import { WorkMailQuery } from "@shared/work-mail";
import type { MentionAfter, MentionRow } from "../../junto/work/mention-backlinks";
import { readMentions } from "../../junto/work/mention-backlinks";
import { WorkRepository } from "../../junto/work/repository";
import { WorkService } from "../../junto/work/service";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.work.topology": CoreOp<{ readonly canvasName: string }, { readonly canvas: Canvas }>;
    "ipc.work.mailbox": CoreOp<
      { readonly canvasName: string; readonly nodeId: string },
      ReadonlyArray<Message>
    >;
    "ipc.work.mentions": CoreOp<
      {
        readonly canvasName: string;
        readonly key: string;
        readonly limit: number;
        readonly after?: MentionAfter;
      },
      ReadonlyArray<MentionRow>
    >;
    /** The window's work pages; their answers are the repository's own shapes. */
    "ipc.work.item": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.work.attention": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.work.sinkPage": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.work.mailPage": CoreOp<{ readonly input: unknown }, unknown>;
    "ipc.work.seatRecentOps": CoreOp<
      { readonly canvas: string; readonly nodeId: string; readonly limit?: number },
      unknown
    >;
  }
}

/** A renderer argument, decoded in the core where the query is used. */
const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input);

coreOps({
  "ipc.work.topology": ({ canvasName }) =>
    Effect.map(
      Effect.flatMap(WorkService, (work) => work.readTopology(canvasName)),
      (read) => ({ canvas: read.canvas }),
    ),
  "ipc.work.mailbox": ({ canvasName, nodeId }) =>
    Effect.flatMap(WorkService, (work) => work.readMailbox(canvasName, nodeId)),
  "ipc.work.mentions": ({ canvasName, key, limit, after }) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => readMentions(sql, canvasName, key, limit, after)),
  "ipc.work.item": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* decode(WorkItemQuery, input);
      return yield* (yield* WorkRepository).taskItem(query);
    }),
  "ipc.work.attention": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* decode(WorkAttentionQuery, input);
      return yield* (yield* WorkRepository).attentionSnapshot(query);
    }),
  "ipc.work.sinkPage": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* decode(WorkSinkQuery, input);
      return yield* (yield* WorkRepository).sinkPage(query);
    }),
  "ipc.work.mailPage": ({ input }) =>
    Effect.gen(function* () {
      const query = yield* decode(WorkMailQuery, input);
      return yield* (yield* WorkRepository).mailPage(query);
    }),
  "ipc.work.seatRecentOps": ({ canvas, nodeId, limit }) =>
    Effect.flatMap(WorkService, (work) => work.workSeatRecentOps(canvas, nodeId, limit)),
});
