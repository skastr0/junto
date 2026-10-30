// The renderer's backlinks over IPC (work/mentions.ts names them): where a
// seat, a task, an artifact or a page is mentioned. Read only, answered in
// the core (`core-process/ops/mention-ipc.ts`) where `work_mentions` lives,
// and every added backlink reaches the panes from there.

import type { IpcMain } from "electron";
import { MENTION_IPC_CHANNELS } from "@shared/mention-ipc-channels";
import type { MentionsChanged } from "@shared/mention-ipc";
import { core } from "../../core-process/main-client";
import { subscribe as onCorePush } from "../../core-process/push";

/** The list on its channel, and every added backlink told to the windows. Returns the unsubscribe. */
export const registerMentionIpc = (
  ipc: Pick<IpcMain, "handle">,
  broadcast: (channel: string, payload: MentionsChanged) => void,
): (() => void) => {
  ipc.handle(MENTION_IPC_CHANNELS.list, (_event, input: unknown) =>
    core.call("ipc.mention.list", { input }),
  );
  return onCorePush(MENTION_IPC_CHANNELS.changed, (event) =>
    broadcast(MENTION_IPC_CHANNELS.changed, event as MentionsChanged),
  );
};
