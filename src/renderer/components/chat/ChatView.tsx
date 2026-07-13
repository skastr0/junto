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
import { DIM, HUE, withAlpha } from "../../lib/theme";
import { ChatTranscript } from "./ChatTranscript";
import { ChatComposer, type ChatContextBlock } from "./ChatComposer";
import "./chat.css";

const STATUS_DOT: Record<AgentChatState["status"], { readonly color: string; readonly pulse: boolean }> = {
  idle: { color: DIM, pulse: false },
  connecting: { color: HUE.amber, pulse: true },
  live: { color: "#5FB98E", pulse: false },
  closed: { color: DIM, pulse: false },
  error: { color: HUE.crimson, pulse: false },
};

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

  const dot = STATUS_DOT[agentState.status];
  const isLive = agentState.status === "live";
  const usageText = formatUsage(agentState.usage);

  return (
    <div className="chat-view">
      <div className="chat-header">
        <div className="chat-header__top">
          <span className={`chat-status-dot${dot.pulse ? " vellum-dot--pulse" : ""}`} style={{ background: dot.color }} />
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
            <div className="chat-empty__line vellum-dot--pulse" style={{ color: DIM }}>connecting…</div>
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
