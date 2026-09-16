import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { ThinkingOrb, type OrbState } from "thinking-orbs";
import {
  answerPermission,
  chatState$,
  markRead,
  openChat,
  sendPrompt,
  setModel,
  subscribeChatEvents,
  type AgentChatState,
  type ChatItem,
} from "../../lib/chat-state";
import { chatActivity } from "../../lib/activity";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { Dropdown, OverlayHeader } from "../ui";
import { ChatTranscript } from "./ChatTranscript";
import { ChatComposer, type ChatContextBlock } from "./ChatComposer";
import "./chat.css";

function formatUsage(usage: AgentChatState["usage"]): string | undefined {
  if (!usage) return undefined;
  const total =
    usage.totalTokens ??
    (usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined);
  if (total === undefined) return undefined;
  if (total >= 1_000) return `${(total / 1_000).toFixed(total >= 10_000 ? 1 : 2)}k tok`;
  return `${total.toLocaleString()} tok`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function resolveOrbState(input: {
  readonly status: AgentChatState["status"];
  readonly turnBusy: boolean;
  readonly pendingPermission: boolean;
  readonly hasBusyTools: boolean;
}): { readonly state: OrbState; readonly label: string; readonly paused: boolean; readonly speed: number } {
  if (input.status === "connecting") {
    return { state: "searching", label: "Connecting to ACP…", paused: false, speed: 0.8 };
  }
  if (input.pendingPermission) {
    return { state: "solving", label: "Waiting for operator permission…", paused: false, speed: 0.65 };
  }
  if (input.hasBusyTools) {
    return { state: "working", label: "Agent is using tools…", paused: false, speed: 0.8 };
  }
  if (input.turnBusy) {
    return { state: "composing", label: "Agent is composing…", paused: false, speed: 0.72 };
  }
  if (input.status === "live") {
    return { state: "listening", label: "ACP is listening", paused: false, speed: 0.45 };
  }
  return {
    state: "shaping",
    label: input.status === "error" ? "ACP connection error" : "ACP is detached",
    paused: true,
    speed: 1,
  };
}

function activityLabel(item: ChatItem): string {
  switch (item.kind) {
    case "tool":
      return item.title;
    case "permission":
      return item.answeredOptionId ? "permission answered" : "permission needed";
    case "plan":
      return "plan updated";
    case "assistant":
      return "agent replied";
    case "user":
      return "prompt sent";
    case "thought":
      return "reasoning updated";
    case "status":
      return item.text;
  }
}

function SessionRail({
  sessionId,
  contextBlocks,
  transcript,
}: {
  readonly sessionId?: string;
  readonly contextBlocks: ReadonlyArray<ChatContextBlock>;
  readonly transcript: ReadonlyArray<ChatItem>;
}) {
  const activity = useMemo(() => transcript.slice(-4).reverse(), [transcript]);
  return (
    <aside className="chat-session-rail" aria-label="ACP session context">
      <section className="chat-session-rail__section">
        <div className="chat-session-rail__label">session</div>
        <div className="chat-session-rail__value" title={sessionId}>
          {sessionId ? `${sessionId.slice(0, 10)}…` : "not attached"}
        </div>
      </section>
      {contextBlocks.length > 0 ? (
        <section className="chat-session-rail__section">
          <div className="chat-session-rail__label">context</div>
          <div className="chat-session-rail__chips">
            {contextBlocks.map((block, index) => (
              <span key={`${block.label}-${index}`} className="chat-context-chip" title={block.text}>
                {block.label}
              </span>
            ))}
          </div>
        </section>
      ) : null}
      <section className="chat-session-rail__section">
        <div className="chat-session-rail__label">activity</div>
        {activity.length > 0 ? (
          <ol className="chat-session-rail__activity">
            {activity.map((item) => (
              <li key={item.id}>
                <span className={`chat-session-rail__mark chat-session-rail__mark--${item.kind}`} />
                <span>
                  <time>{formatClock(item.ts)}</time>
                  <span>{activityLabel(item)}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="chat-session-rail__empty">No session activity yet.</div>
        )}
      </section>
    </aside>
  );
}

export function ChatView({
  agentKey,
  displayName: displayNameProp,
  contextBlocks = [],
  actions,
}: {
  readonly agentKey: string;
  readonly displayName?: string;
  readonly contextBlocks?: ReadonlyArray<ChatContextBlock>;
  readonly actions?: ReactNode;
}) {
  const agent$ = chatState$[agentKey];
  const status = use$(agent$.status) ?? "idle";
  const models = use$(agent$.models) ?? [];
  const selectedModelId = use$(agent$.selectedModelId);
  const usage = use$(agent$.usage);
  const turnBusy = use$(agent$.turnBusy) ?? false;
  const pendingPermission = use$(agent$.pendingPermission);
  const error = use$(agent$.error);
  const authMethods = use$(agent$.authMethods);
  const sessionId = use$(agent$.sessionId);
  const transcript = use$(agent$.transcript) ?? [];

  const displayName = displayNameProp ?? agentKey;

  const onAnswerPermission = useCallback(
    (requestId: string, optionId: string) => {
      void answerPermission(agentKey, requestId, optionId);
    },
    [agentKey],
  );

  useEffect(() => {
    subscribeChatEvents();
  }, []);
  useEffect(() => {
    markRead(agentKey);
  }, [agentKey, transcript.length]);

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
  const orb = resolveOrbState({
    status,
    turnBusy,
    pendingPermission: Boolean(pendingPermission),
    hasBusyTools: tools.some((tool) => tool.status === "pending" || tool.status === "in_progress"),
  });
  const station = agentKey.split(":")[0] || "local";
  const statusText =
    status === "live"
      ? `${station} - ACP - live`
      : status === "connecting"
        ? `${station} - ACP - connecting`
        : `${station} - ACP - ${status}`;

  const headerActions = (
    <>
      {isLive && models.length > 0 ? (
        <Dropdown
          aria-label="Model"
          className="chat-header__model"
          triggerClassName="junto-picker-select chat-header__model-trigger"
          value={selectedModelId ?? models[0]?.modelId ?? ""}
          options={models.map((model) => ({
            value: model.modelId,
            label: model.description ?? model.modelId,
          }))}
          onChange={(value) => void setModel(agentKey, value)}
        />
      ) : null}
      {usageText ? <span className="chat-header__usage">{usageText}</span> : null}
      {actions}
    </>
  );

  return (
    <div className="chat-view">
      <OverlayHeader
        className="chat-header"
        eyebrow={statusText}
        title={
          <span className="chat-header__identity">
            <span className="chat-header__orb">
              <ThinkingOrb
                state={orb.state}
                size={64}
                theme="dark"
                speed={orb.speed}
                paused={orb.paused}
                aria-label={orb.label}
                style={{ width: "100%", height: "100%" }}
              />
            </span>
            <span title={displayName ?? agentKey}>{displayName ?? agentKey}</span>
            <ActivityMarkFromSpec spec={headerActivity} size="inline" />
          </span>
        }
        actions={headerActions}
      />

      {!isLive ? (
        <div className="chat-empty">
          {status === "connecting" ? (
            <ActivityMarkFromSpec
              spec={{ mode: "wave", tone: "amber", label: "connecting" }}
              size="inline"
            />
          ) : (
            <>
              <div className={`chat-empty__line${status === "error" ? " chat-empty__line--error" : ""}`}>
                {status === "error"
                  ? error ?? "Chat failed to open."
                  : status === "closed"
                    ? "ACP session closed."
                    : "ACP is not attached."}
              </div>
              {authMethods && authMethods.length > 0 ? (
                <div className="chat-empty__hint">Sign in via {authMethods.join(", ")}.</div>
              ) : null}
              <button
                type="button"
                className="chat-attach-button"
                onClick={() => void openChat(agentKey, sessionId)}
              >
                {status === "closed" ? "reconnect" : "attach"}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="chat-workspace">
          <main className="chat-ledger">
            {transcript.length > 0 ? (
              <ChatTranscript items={transcript} onAnswerPermission={onAnswerPermission} />
            ) : (
              <div className="chat-transcript chat-transcript--empty">
                <span>Connected. Message {displayName ?? agentKey} to begin.</span>
              </div>
            )}
            <ChatComposer
              contextBlocks={contextBlocks}
              onSend={(text) => void sendPrompt(agentKey, text, contextBlocks)}
            />
          </main>
          <SessionRail
            sessionId={sessionId}
            contextBlocks={contextBlocks}
            transcript={transcript}
          />
        </div>
      )}
    </div>
  );
}
