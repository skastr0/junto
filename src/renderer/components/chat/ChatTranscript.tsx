import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Circle, LoaderCircle } from "lucide-react";
import type { ChatItem, ChatPlanEntry } from "../../lib/chat-state";
import { toolActivity } from "../../lib/activity";
import { ActivityMarkFromSpec } from "../ActivityMark";

const PERMISSION_OPTION_LABEL: Record<string, string> = {
  allow_once: "Allow once",
  allow_session: "Allow session",
  allow_always: "Always allow",
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

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LedgerRow({
  actor,
  ts,
  tone,
  className,
  children,
}: {
  readonly actor: string;
  readonly ts: number;
  readonly tone?: "user" | "system";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <article
      className={[
        "chat-ledger-row",
        tone ? `chat-ledger-row--${tone}` : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
    >
      <header className="chat-ledger-row__meta">
        <span>{actor}</span>
        <time>{formatClock(ts)}</time>
      </header>
      <div className="chat-ledger-row__content">{children}</div>
    </article>
  );
}

const UserMessage = memo(function UserMessage({
  item,
}: {
  readonly item: Extract<ChatItem, { kind: "user" }>;
}) {
  return (
    <LedgerRow actor="you" ts={item.ts} tone="user" className="chat-message--user">
      <pre className="chat-message__text">{item.text}</pre>
    </LedgerRow>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  item,
}: {
  readonly item: Extract<ChatItem, { kind: "assistant" }>;
}) {
  return (
    <LedgerRow actor="agent" ts={item.ts} className="chat-message--assistant">
      <pre className="chat-message__text">{item.text}</pre>
    </LedgerRow>
  );
});

const ThoughtMessage = memo(function ThoughtMessage({
  item,
}: {
  readonly item: Extract<ChatItem, { kind: "thought" }>;
}) {
  return (
    <LedgerRow actor="agent" ts={item.ts}>
      <details className="chat-thought">
        <summary>Thinking <span>collapsed</span></summary>
        <pre className="chat-thought__text">{item.text}</pre>
      </details>
    </LedgerRow>
  );
});

function PlanEntryRow({ entry, index }: { readonly entry: ChatPlanEntry; readonly index: number }) {
  const done = entry.status === "completed";
  const active = entry.status === "in_progress";
  return (
    <li className="chat-plan__entry">
      <span className="chat-plan__index">{index + 1}.</span>
      <span className="chat-plan__content">{entry.content}</span>
      <span className={`chat-plan__status${done ? " is-done" : active ? " is-active" : ""}`}>
        {done ? <Check size={12} /> : active ? <LoaderCircle size={12} /> : <Circle size={8} />}
        {done ? "done" : active ? "in progress" : entry.status}
      </span>
    </li>
  );
}

const PlanStrip = memo(function PlanStrip({
  item,
}: {
  readonly item: Extract<ChatItem, { kind: "plan" }>;
}) {
  return (
    <LedgerRow actor="agent" ts={item.ts}>
      <div className="chat-plan__title">Plan</div>
      <ol className="chat-plan">
        {item.entries.map((entry, index) => (
          <PlanEntryRow key={`${entry.content}-${index}`} entry={entry} index={index} />
        ))}
      </ol>
    </LedgerRow>
  );
});

const ToolCard = memo(function ToolCard({
  item,
}: {
  readonly item: Extract<ChatItem, { kind: "tool" }>;
}) {
  const activity = toolActivity(item.status);
  const hasDetail =
    item.rawInput !== undefined || item.rawOutput !== undefined || Boolean(item.contentText);
  return (
    <LedgerRow actor="tools" ts={item.ts} tone="system">
      <details className="chat-tool-card">
        <summary>
          <span className="chat-tool-card__chevron">›</span>
          <span className="chat-tool-card__name" title={item.title}>{item.title}</span>
          <ActivityMarkFromSpec spec={activity} size="inline" />
          <span className="chat-tool-card__status">{item.status.replace("_", " ")}</span>
        </summary>
        {hasDetail ? (
          <div className="chat-tool-card__details">
            {item.rawInput !== undefined ? <pre>{formatBlock(item.rawInput)}</pre> : null}
            {item.contentText ? <pre>{item.contentText}</pre> : null}
            {item.rawOutput !== undefined ? <pre>{formatBlock(item.rawOutput)}</pre> : null}
          </div>
        ) : null}
      </details>
    </LedgerRow>
  );
});

const PermissionCard = memo(function PermissionCard({
  item,
  onAnswerPermission,
}: {
  readonly item: Extract<ChatItem, { kind: "permission" }>;
  readonly onAnswerPermission: (requestId: string, optionId: string) => void;
}) {
  const answered = Boolean(item.answeredOptionId);
  return (
    <LedgerRow actor="agent" ts={item.ts}>
      <div className="chat-permission-card">
        <div className="chat-permission-card__copy">
          {!answered ? (
            <ActivityMarkFromSpec
              spec={{ mode: "wave", tone: "amber", label: "awaiting permission" }}
              size="inline"
            />
          ) : null}
          <span>{item.toolKind ? `${item.toolKind} - ` : ""}{item.title}</span>
        </div>
        <div className="chat-permission-card__options">
          {item.options.map((option) => {
            const isChosen = item.answeredOptionId === option.optionId;
            const denied = option.optionId.startsWith("deny");
            return (
              <button
                key={option.optionId}
                type="button"
                disabled={answered}
                className={[
                  "chat-permission-card__option",
                  isChosen ? "is-chosen" : "",
                  denied ? "is-deny" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => onAnswerPermission(item.requestId, option.optionId)}
              >
                {PERMISSION_OPTION_LABEL[option.optionId] ?? option.label}
              </button>
            );
          })}
        </div>
      </div>
    </LedgerRow>
  );
});

const StatusLine = memo(function StatusLine({
  item,
}: {
  readonly item: Extract<ChatItem, { kind: "status" }>;
}) {
  return (
    <LedgerRow actor="system" ts={item.ts} tone="system">
      <div className={`chat-status-line${item.level === "error" ? " is-error" : ""}`}>
        {item.text}
      </div>
    </LedgerRow>
  );
});

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

  return (
    <div
      ref={scrollRef}
      className="chat-transcript nowheel"
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
      }}
    >
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserMessage key={item.id} item={item} />;
          case "assistant":
            return <AssistantMessage key={item.id} item={item} />;
          case "thought":
            return <ThoughtMessage key={item.id} item={item} />;
          case "plan":
            return <PlanStrip key={item.id} item={item} />;
          case "tool":
            return <ToolCard key={item.id} item={item} />;
          case "permission":
            return (
              <PermissionCard
                key={item.id}
                item={item}
                onAnswerPermission={onAnswerPermission}
              />
            );
          case "status":
            return <StatusLine key={item.id} item={item} />;
        }
      })}
    </div>
  );
}
