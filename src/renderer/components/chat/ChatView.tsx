import { useCallback, useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import {
  answerPermission,
  chatState$,
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
//
// Header fields and transcript subscribe separately so streaming (transcript
// only) does not pull through whole-agent state; PermissionCard keeps memo via
// a stable onAnswerPermission.
export function ChatView({
  agentKey,
  displayName: displayNameProp,
  contextBlocks = [],
}: {
  readonly agentKey: string;
  readonly displayName?: string;
  readonly contextBlocks?: ReadonlyArray<ChatContextBlock>;
}) {
  const agent$ = chatState$[agentKey];

  // Header / chrome — field-level so usage/status/model updates stay local.
  const status = use$(agent$.status) ?? "idle";
  const models = use$(agent$.models) ?? [];
  const selectedModelId = use$(agent$.selectedModelId);
  const usage = use$(agent$.usage);
  const turnBusy = use$(agent$.turnBusy) ?? false;
  const pendingPermission = use$(agent$.pendingPermission);
  const error = use$(agent$.error);
  const authMethods = use$(agent$.authMethods);
  const sessionId = use$(agent$.sessionId);

  // Transcript — separate subscription; streaming tokens only touch this path.
  const transcript = use$(agent$.transcript) ?? [];

  const [displayName, setDisplayName] = useState(displayNameProp);

  const onAnswerPermission = useCallback(
    (requestId: string, optionId: string) => {
      void answerPermission(agentKey, requestId, optionId);
    },
    [agentKey],
  );

  useEffect(() => { subscribeChatEvents(); }, []);
  useEffect(() => { markRead(agentKey); }, [agentKey, transcript.length]);

  useEffect(() => {
    if (displayNameProp) { setDisplayName(displayNameProp); return; }
    let cancelled = false;
    void getAgentIdentity(agentKey).then((identity) => { if (!cancelled) setDisplayName(identity?.displayName); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [agentKey, displayNameProp]);

  const isLive = status === "live";
  const usageText = formatUsage(usage);
  const tools = transcript
    .filter((item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool")
    .map((item) => ({ status: item.status }));
  const headerActivity = chatActivity({
    status,
    pendingPermission: Boolean(pendingPermission),
    tools,
    sending: turnBusy,
  });

  return (
    <div className="chat-view">
      <div className="chat-header">
        <div className="chat-header__top">
          <ActivityMarkFromSpec spec={headerActivity} size="inline" />
          <span className="chat-header__name" title={displayName ?? agentKey}>{displayName ?? agentKey}</span>
        </div>
        {(isLive && models.length > 0) || usageText ? (
          <div className="chat-header__bottom">
            {isLive && models.length > 0 ? (
              <select
                aria-label="Model"
                className="vellum-picker-select chat-header__model"
                value={selectedModelId ?? models[0]?.modelId}
                onChange={(event) => void setModel(agentKey, event.target.value)}
              >
                {models.map((model) => <option key={model.modelId} value={model.modelId}>{model.description ?? model.modelId}</option>)}
              </select>
            ) : null}
            {usageText ? <span className="chat-header__usage">{usageText}</span> : null}
          </div>
        ) : null}
      </div>

      {!isLive ? (
        <div className="chat-empty">
          {status === "connecting" ? (
            <div className="chat-empty__line" style={{ color: DIM, display: "flex", alignItems: "center", gap: 8 }}>
              <ActivityMarkFromSpec spec={{ mode: "wave", tone: "amber", label: "connecting" }} size="inline" />
            </div>
          ) : (
            <>
              <div className="chat-empty__line" style={{ color: status === "error" ? withAlpha(HUE.crimson, 0.85) : DIM }}>
                {status === "error"
                  ? (error ?? "chat failed to open")
                  : status === "closed" ? "chat closed." : "not attached."}
              </div>
              {authMethods && authMethods.length > 0 ? (
                <div className="chat-empty__hint">sign in via: {authMethods.join(", ")}</div>
              ) : null}
              <button type="button" className="chat-attach-button" onClick={() => void openChat(agentKey, sessionId)}>
                {status === "closed" ? "reconnect" : "attach"}
              </button>
            </>
          )}
        </div>
      ) : null}

      {transcript.length > 0 ? (
        <ChatTranscript
          items={transcript}
          onAnswerPermission={onAnswerPermission}
        />
      ) : isLive ? (
        <div className="chat-transcript chat-transcript--empty"><span style={{ color: DIM }}>say something to start.</span></div>
      ) : null}

      {isLive ? <ChatComposer contextBlocks={contextBlocks} onSend={(text) => void sendPrompt(agentKey, text, contextBlocks)} /> : null}
    </div>
  );
}
