/**
 * What the window reads through the work core (junto/ipc.ts): a canvas
 * topology for the resource, mention and link ports, a node's comments, and a
 * node's mentions. The topology answer is the canvas itself, which crosses the
 * port as plain data (maps and arrays), never a service.
 */
import { Effect } from "effect";
import type { Canvas } from "@shared/model";
import type { Message } from "@shared/work-model";
import { SqlClient } from "effect/unstable/sql";
import type { MentionAfter, MentionRow } from "../../junto/work/mention-backlinks";
import { readMentions } from "../../junto/work/mention-backlinks";
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
  }
}

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
});
