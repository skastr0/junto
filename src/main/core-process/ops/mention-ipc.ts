/**
 * The window's backlinks read (work/mention-ipc.ts): where a seat, a task, an
 * artifact or a page is mentioned, read from `work_mentions` and named
 * against the canvas as it is now. Every added backlink is published here as
 * its write commits, and main relays that to the windows.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { MENTION_IPC_CHANNELS } from "@shared/mention-ipc-channels";
import { MentionListInput, type MentionPage } from "@shared/mention-ipc";
import type { WorkErrorBody } from "@shared/work-control";
import { onMentionsChanged, readMentions, type MentionAfter } from "../../junto/work/mention-backlinks";
import { listMentions, type MentionIpcPorts } from "../../junto/work/mentions";
import { WorkService } from "../../junto/work/service";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

declare module "../ops" {
  interface CoreOps {
    "ipc.mention.list": CoreOp<{ readonly input: unknown }, MentionPage>;
  }
}

// Every added backlink, from any writer, reaches the panes as it commits.
onMentionsChanged((canvasName) => publish(MENTION_IPC_CHANNELS.changed, { canvasName }));

const unreadable = (canvasName: string) => (): WorkErrorBody => ({
  type: "InternalError",
  message: `the mentions on canvas ${canvasName} could not be read`,
  details: { retryable: true },
});

const ports: MentionIpcPorts<SqlClient.SqlClient | WorkService> = {
  topology: (canvasName) =>
    Effect.flatMap(WorkService, (work) => work.readTopology(canvasName)).pipe(
      Effect.map((read) => read.canvas),
      Effect.mapError(unreadable(canvasName)),
    ),
  read: (canvasName, key, limit, after: MentionAfter | undefined) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => readMentions(sql, canvasName, key, limit, after)).pipe(
      Effect.mapError(unreadable(canvasName)),
    ),
};

coreOps({
  "ipc.mention.list": ({ input }) =>
    Effect.gen(function* () {
      const decoded = yield* Schema.decodeUnknownEffect(MentionListInput)(input, { onExcessProperty: "error" });
      return yield* listMentions(ports, decoded);
    }),
});
