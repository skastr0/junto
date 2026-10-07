import { batch, observable } from "@legendapp/state";
import type { ChatChromeChanged, ChatChromeSnapshot, ChatChromeState } from "@shared/chat-chrome";
import type { ChatApi } from "@shared/ipc";
import { keepUnchanged } from "./model-store";

// The authoritative ACP chrome plane, independent of opening a ChatView.
export type { ChatChromeChanged, ChatChromeSnapshot } from "@shared/chat-chrome";
export type ChatChromeApi = Pick<ChatApi, "chatChrome" | "onChatChromeChanged">;

/** Subscribe before the initial read, retaining newer changes until its snapshot arrives. */
export const createChatChromeStore = (getApi: () => ChatChromeApi | undefined) => {
  const state = observable({
    byAgentKey: {} as Record<string, ChatChromeState | undefined>,
    hydrated: false,
    error: "",
  });
  let users = 0, generation = 0, revision = -1;
  let off: (() => void) | undefined;
  let pending: ChatChromeChanged[] | undefined;
  const publish = (row: ChatChromeState) => {
    const previous = state.byAgentKey[row.agentKey].peek();
    const next = keepUnchanged(previous, row);
    if (next !== previous) state.byAgentKey[row.agentKey].set(next);
  };
  const apply = (event: ChatChromeChanged) => {
    if (event.revision <= revision) return;
    revision = event.revision;
    publish(event.state);
  };
  const start = () => {
    const api = getApi();
    if (!api || typeof api.chatChrome !== "function" || typeof api.onChatChromeChanged !== "function") return;
    const current = ++generation;
    pending = []; revision = -1;
    state.hydrated.set(false);
    off = api.onChatChromeChanged((event) => {
      if (current !== generation) return;
      if (pending) pending.push(event);
      else apply(event);
    });
    void api.chatChrome().then((snapshot) => {
      if (current !== generation) return;
      batch(() => {
        const live = new Set(snapshot.states.map((row) => row.agentKey));
        for (const key of Object.keys(state.byAgentKey.peek())) {
          if (!live.has(key)) state.byAgentKey[key].delete();
        }
        for (const row of snapshot.states) publish(row);
        revision = snapshot.revision;
        for (const event of pending?.sort((a, b) => a.revision - b.revision) ?? []) apply(event);
        pending = undefined;
        state.error.set(""); state.hydrated.set(true);
      });
    }, (error) => {
      if (current !== generation) return;
      batch(() => {
        for (const event of pending?.sort((a, b) => a.revision - b.revision) ?? []) apply(event);
        pending = undefined;
        state.error.set(error instanceof Error ? error.message : String(error));
      });
    });
  };
  return {
    state,
    retain: () => {
      if (++users === 1) start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--users === 0) { ++generation; off?.(); off = undefined; pending = undefined; }
      };
    },
  };
};
