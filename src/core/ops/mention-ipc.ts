/**
 * The core's handlers of the mention group (src/contract/core/mention-ipc.ts):
 * where a seat, a task, an artifact or a page is mentioned, read from
 * `work_mentions` and named against the canvas as it is now. Every added
 * backlink, from any writer, is published through `CorePushes` as its write
 * commits, for as long as the server runs, and main relays it to the windows.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { MENTION_IPC_CHANNELS } from "@shared/mention-ipc-channels";
import type { WorkErrorBody } from "@shared/work-control";
import { MentionRpcs, MentionsUnreadable } from "../../contract/core/mention-ipc";
import { onMentionsChanged, readMentions, type MentionAfter } from "../work/mention-backlinks";
import { listMentions, type MentionIpcPorts } from "../work/mentions";
import { WorkService } from "../work/service";
import { CorePushes } from "../push";

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

export const MentionHandlers = MentionRpcs.toLayer(
  Effect.gen(function* () {
    const pushes = yield* CorePushes;
    // Every added backlink reaches the panes as it commits; the listener
    // leaves with the server.
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        onMentionsChanged((canvasName) => void Effect.runFork(pushes.publish(MENTION_IPC_CHANNELS.changed, { canvasName }))),
      ),
      (stop) => Effect.sync(stop),
    );
    return {
      MentionList: (input) =>
        listMentions(ports, input).pipe(Effect.mapError((error) => new MentionsUnreadable({ message: error.message }))),
    };
  }),
);
