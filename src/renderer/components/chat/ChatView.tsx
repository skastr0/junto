import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import {
  answerPermission,
  chatState$,
  initialAgentChatState,
  markRead,
  openChat,
  sendPrompt,
  setModel,
  subscribeChatEvents,
  type AgentChatState,
} from "../../lib/chat-state";
import { getAgentIdentity } from "../../lib/agent";
import { chatActivity } from "../../lib/activity";
import { DIM, HUE, withAlpha } from "../../lib/theme";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { ChatTranscript } from "./ChatTranscript";
import { ChatComposer, type ChatContextBlock } from "./ChatComposer";
import "./chat.css";

function formatUsage(usage: AgentChatState["usage"]): string | undefined {
  if (!usage) return undefined;
  const total = usage.totalTokens
    ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined);
  if (total === undefined) return undefined;
  return `${total.toLocaleString()} tok`;
}

// The default inspector tab for agent nodes. Self-sufficient given only
// agentKey — self-fetches displayName (unless the caller supplies one) and
// registers the shared chat-event subscription, so mounting it is a one-line
// affair for the orchestrator.
export function ChatView({
  agentKey,
  displayName: displayNameProp,
  contextBlocks = [],
}: {
  readonly agentKey: string;
  readonly displayName?: string;
  readonly contextBlocks?: ReadonlyArray<ChatContextBlock>;
}) {
  const raw = use$(chatState$[agentKey]);
  const agentState = raw ?? initialAgentChatState();
  const [displayName, setDisplayName] = useState(displayNameProp);

  useEffect(() => { subscribeChatEvents(); }, []);
  useEffect(() => { markRead(agentKey); }, [agentKey, agentState.transcript.length]);

  useEffect(() => {
    if (displayNameProp) { setDisplayName(displayNameProp); return; }
    let cancelled = false;
    void getAgentIdentity(agentKey).then((identity) => { if (!cancelled) setDisplayName(identity?.displayName); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [agentKey, displayNameProp]);

  const isLive = agentState.status === "live";
  const usageText = formatUsage(agentState.usage);
  const tools = agentState.transcript
    .filter((item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool")
    .map((item) => ({ status: item.status }));
  const headerActivity = chatActivity({
    status: agentState.status,
    pendingPermission: Boolean(agentState.pendingPermission),
    tools,
  });

  return (
    <div className="chat-view">
      <div className="chat-header">
        <div className="chat-header__top">
          <ActivityMarkFromSpec spec={headerActivity} size="inline" />
          <span className="chat-header__name" title={displayName ?? agentKey}>{displayName ?? agentKey}</span>
        </div>
        {(isLive && agentState.models.length > 0) || usageText ? (
          <div className="chat-header__bottom">
            {isLive && agentState.models.length > 0 ? (
              <select
                aria-label="Model"
                className="vellum-picker-select chat-header__model"
                value={agentState.selectedModelId ?? agentState.models[0]?.modelId}
                onChange={(event) => void setModel(agentKey, event.target.value)}
              >
                {agentState.models.map((model) => <option key={model.modelId} value={model.modelId}>{model.description ?? model.modelId}</option>)}
              </select>
            ) : null}
            {usageText ? <span className="chat-header__usage">{usageText}</span> : null}
          </div>
        ) : null}
      </div>

      {!isLive ? (
        <div className="chat-empty">
          {agentState.status === "connecting" ? (
            <div className="chat-empty__line" style={{ color: DIM, display: "flex", alignItems: "center", gap: 8 }}>
              <ActivityMarkFromSpec spec={{ mode: "wave", tone: "amber", label: "connecting" }} size="inline" />
            </div>
          ) : (
            <>
              <div className="chat-empty__line" style={{ color: agentState.status === "error" ? withAlpha(HUE.crimson, 0.85) : DIM }}>
                {agentState.status === "error"
                  ? (agentState.error ?? "chat failed to open")
                  : agentState.status === "closed" ? "chat closed." : "not attached."}
              </div>
              {agentState.authMethods && agentState.authMethods.length > 0 ? (
                <div className="chat-empty__hint">sign in via: {agentState.authMethods.join(", ")}</div>
              ) : null}
              <button type="button" className="chat-attach-button" onClick={() => void openChat(agentKey, agentState.sessionId)}>
                {agentState.status === "closed" ? "reconnect" : "attach"}
              </button>
            </>
          )}
        </div>
      ) : null}

      {agentState.transcript.length > 0 ? (
        <ChatTranscript
          items={agentState.transcript}
          onAnswerPermission={(requestId, optionId) => void answerPermission(agentKey, requestId, optionId)}
        />
      ) : isLive ? (
        <div className="chat-transcript chat-transcript--empty"><span style={{ color: DIM }}>say something to start.</span></div>
      ) : null}

      {isLive ? <ChatComposer contextBlocks={contextBlocks} onSend={(text) => void sendPrompt(agentKey, text, contextBlocks)} /> : null}
    </div>
  );
}
