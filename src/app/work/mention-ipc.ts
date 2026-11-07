// The renderer's backlinks over IPC (work/mentions.ts names them): where a
// seat, a task, an artifact or a page is mentioned. Read only, answered by the
// core's mention group (`contract/core/mention-ipc.ts`) where `work_mentions`
// lives, and every added backlink reaches the panes from there. The query is
// decoded here, at main's edge, closed; one that does not decode rejects.

import type { IpcMain } from "electron";
import { Context, Effect, Schema } from "effect";
import { MENTION_IPC_CHANNELS } from "@shared/mention-ipc-channels";
import { MentionListInput, type MentionsChanged } from "@shared/mention-ipc";
import { MentionCore } from "../../contract/core/mention-ipc";
import { CorePushesMain } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";

/** The list on its channel, and every added backlink told to the windows. Returns the unsubscribe. */
export const registerMentionIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: MentionsChanged) => void,
  core: Context.Context<MentionCore | CorePushesMain>,
): (() => void) => {
  const mentions = Context.get(core, MentionCore);
  const pushes = Context.get(core, CorePushesMain);
  ipc.handle(MENTION_IPC_CHANNELS.list, (_event, raw: unknown) =>
    AppRuntime.runPromise(
      Effect.flatMap(Schema.decodeUnknownEffect(MentionListInput)(raw, { onExcessProperty: "error" }), (input) =>
        mentions.MentionList(input),
      ),
    ),
  );
  return pushes.subscribe(MENTION_IPC_CHANNELS.changed, (event) => broadcast(MENTION_IPC_CHANNELS.changed, event));
};
