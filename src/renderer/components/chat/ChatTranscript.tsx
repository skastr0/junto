import { useEffect, useRef, useState } from "react";
import type { ChatItem, ChatPlanEntry } from "../../lib/chat-state";
import { toolActivity } from "../../lib/activity";
import { DIM, HUE, INK, withAlpha } from "../../lib/theme";
import { ActivityMarkFromSpec } from "../ActivityMark";

// One card per ChatItem kind. Kept deliberately quiet — the transcript is a
// record to scan, not a marketing surface.

const PERMISSION_OPTION_LABEL: Record<string, string> = {
  allow_once: "Allow once",
  allow_session: "Allow session",
  allow_always: "Allow always",
  deny: "Deny",
  deny_always: "Deny always",
};

function formatBlock(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function UserMessage({ item }: { readonly item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <div className="chat-message chat-message--user">
      <pre className="chat-message__text">{item.text}</pre>
    </div>
  );
}

function AssistantMessage({ item }: { readonly item: Extract<ChatItem, { kind: "assistant" }> }) {
  return (
    <div className="chat-message chat-message--assistant">
      <pre className="chat-message__text">{item.text}</pre>
    </div>
  );
}

function ThoughtMessage({ item }: { readonly item: Extract<ChatItem, { kind: "thought" }> }) {
  return (
    <details className="chat-thought">
      <summary>thinking…</summary>
      <pre className="chat-thought__text">{item.text}</pre>
    </details>
  );
}

function PlanEntryRow({ entry }: { readonly entry: ChatPlanEntry }) {
  const done = entry.status === "completed";
  const active = entry.status === "in_progress";
  return (
    <div className="chat-plan__entry">
      <span className="chat-plan__dot" style={{ background: done ? "#5FB98E" : active ? HUE.amber : "rgba(237,230,218,.25)" }} />
      <span style={{ color: done ? DIM : INK, textDecoration: done ? "line-through" : "none" }}>{entry.content}</span>
    </div>
  );
}

function PlanStrip({ item }: { readonly item: Extract<ChatItem, { kind: "plan" }> }) {
  return (
    <div className="chat-plan">
      {item.entries.map((entry, index) => <PlanEntryRow key={index} entry={entry} />)}
    </div>
  );
}

function ToolCard({ item }: { readonly item: Extract<ChatItem, { kind: "tool" }> }) {
  const activity = toolActivity(item.status);
  const hasDetail = item.rawInput !== undefined || item.rawOutput !== undefined || Boolean(item.contentText);
  return (
    <div className="chat-tool-card">
      <div className="chat-tool-card__head">
        <span className="chat-tool-card__name" title={item.title}>{item.title}</span>
        <ActivityMarkFromSpec spec={activity} size="inline" />
      </div>
      {hasDetail ? (
        <details className="chat-tool-card__details">
          <summary>args / output</summary>
          {item.rawInput !== undefined ? <pre>{formatBlock(item.rawInput)}</pre> : null}
          {item.contentText ? <pre>{item.contentText}</pre> : null}
          {item.rawOutput !== undefined ? <pre>{formatBlock(item.rawOutput)}</pre> : null}
        </details>
      ) : null}
    </div>
  );
}

function PermissionCard({
  item,
  onAnswer,
}: {
  readonly item: Extract<ChatItem, { kind: "permission" }>;
  readonly onAnswer: (optionId: string) => void;
}) {
  const answered = Boolean(item.answeredOptionId);
  return (
    <div className="chat-permission-card">
      <div className="chat-permission-card__title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {!answered ? <ActivityMarkFromSpec spec={{ mode: "wave", tone: "amber", label: "awaiting permission" }} size="inline" /> : null}
        <span>{item.toolKind ? `${item.toolKind} · ` : ""}{item.title}</span>
      </div>
      <div className="chat-permission-card__options">
        {item.options.map((option) => {
          const isChosen = item.answeredOptionId === option.optionId;
          return (
            <button
              key={option.optionId}
              type="button"
              disabled={answered}
              className={`chat-permission-card__option${isChosen ? " is-chosen" : ""}${option.optionId.startsWith("deny") ? " is-deny" : ""}`}
              onClick={() => onAnswer(option.optionId)}
            >
              {PERMISSION_OPTION_LABEL[option.optionId] ?? option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusLine({ item }: { readonly item: Extract<ChatItem, { kind: "status" }> }) {
  return (
    <div className="chat-status-line" style={{ color: item.level === "error" ? withAlpha(HUE.crimson, 0.85) : DIM }}>
      {item.text}
    </div>
  );
}

export function ChatTranscript({
  items,
  onAnswerPermission,
}: {
  readonly items: ReadonlyArray<ChatItem>;
  readonly onAnswerPermission: (requestId: string, optionId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) el.scrollTop = el.scrollHeight;
  }, [items, stickToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStickToBottom(distanceFromBottom < 24);
  };

  return (
    <div ref={scrollRef} className="chat-transcript nowheel" onScroll={handleScroll}>
      {items.map((item) => {
        switch (item.kind) {
          case "user": return <UserMessage key={item.id} item={item} />;
          case "assistant": return <AssistantMessage key={item.id} item={item} />;
          case "thought": return <ThoughtMessage key={item.id} item={item} />;
          case "plan": return <PlanStrip key={item.id} item={item} />;
          case "tool": return <ToolCard key={item.id} item={item} />;
          case "permission": return <PermissionCard key={item.id} item={item} onAnswer={(optionId) => onAnswerPermission(item.requestId, optionId)} />;
          case "status": return <StatusLine key={item.id} item={item} />;
          default: return null;
        }
      })}
    </div>
  );
}
