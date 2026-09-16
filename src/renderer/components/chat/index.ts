// Mount surface for the chat host: <InspectorTabs .../> + <ChatView .../>
// plus the chat-state store (for reading `unread` into a tab badge).
export { InspectorTabs, type InspectorTab } from "./InspectorTabs";
export { ChatView } from "./ChatView";
export { ChatTranscript } from "./ChatTranscript";
export { ChatComposer, type ChatContextBlock } from "./ChatComposer";
export {
  chatState$,
  chatCoarse$,
  getAgentChatState,
  setAgentChatState,
  initialAgentChatState,
  reduceChatEvent,
  subscribeChatEvents,
  openChat,
  sendPrompt,
  answerPermission,
  setModel,
  closeChat,
  markRead,
  type AgentChatState,
  type AgentChatCoarse,
  type ChatStatus,
  type ChatItem,
  type ChatUserItem,
  type ChatAssistantItem,
  type ChatThoughtItem,
  type ChatToolItem,
  type ChatPlanItem,
  type ChatPlanEntry,
  type ChatPermissionItem,
  type ChatPermissionOption,
  type ChatStatusItem,
  type ChatUsage,
  type ToolStatus,
} from "../../lib/chat-state";
