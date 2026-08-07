import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

export interface ChatContextBlock {
  readonly label: string;
  readonly text: string;
}

const MIN_ROWS = 2;
const MAX_ROWS = 6;

// Textarea grows with content up to MAX_ROWS, then scrolls. ⌘Enter (or
// Ctrl+Enter) sends; Enter alone inserts a newline like every other chat UI.
// onSend may return false (sync/async) to keep the draft (partial multi-fail).
//
// Overlay mode (chat-composer--overlay): footer, eyebrow, and status float over
// the textarea so a short RTS mid panel never clips the send control.
export function ChatComposer({
  contextBlocks = [],
  onSend,
  ariaLabel = "Message",
  placeholder = "Message the agent…",
  hint = "⌘↵ send",
  sendLabel = "send",
  disabled = false,
  status,
  eyebrow,
  className,
}: {
  readonly contextBlocks?: ReadonlyArray<ChatContextBlock>;
  readonly onSend: (text: string) => void | boolean | Promise<void | boolean>;
  readonly ariaLabel?: string;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly sendLabel?: string;
  readonly disabled?: boolean;
  /** Persistent status (aria-live); hint stays for hotkey teaching. */
  readonly status?: string;
  /** Floating label above the draft (multi-prompt seat count, etc.). */
  readonly eyebrow?: string;
  readonly className?: string;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlay = Boolean(className?.includes("chat-composer--overlay"));

  useEffect(() => {
    if (overlay) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight || "14") || 14;
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft, overlay]);

  const send = async () => {
    const text = draft.trim();
    if (!text || disabled || sending) return;
    setSending(true);
    try {
      const result = await onSend(text);
      if (result !== false) setDraft("");
    } finally {
      setSending(false);
    }
  };

  const blocked = disabled || sending || !draft.trim();

  return (
    <div className={["chat-composer", className].filter(Boolean).join(" ")}>
      {eyebrow ? (
        <span className="chat-composer__eyebrow" aria-hidden={false}>
          {eyebrow}
        </span>
      ) : null}
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        rows={MIN_ROWS}
        className="chat-composer__input"
        placeholder={placeholder}
        value={draft}
        disabled={disabled || sending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="chat-composer__footer">
        <div className="chat-composer__tools">
          <div className="chat-context-chips">
            {contextBlocks.map((block, index) => (
              <span key={`${block.label}-${index}`} className="chat-context-chip" title={block.text}>
                {block.label}
              </span>
            ))}
          </div>
          {status ? (
            <span className="chat-composer__status" role="status" aria-live="polite">
              {status}
            </span>
          ) : null}
        </div>
        <div className="chat-composer__submit">
          <span className="chat-composer__hint">{hint}</span>
          <button
            type="button"
            className="chat-composer__send"
            aria-label={sendLabel}
            disabled={blocked}
            onClick={() => void send()}
          >
            <ArrowUp size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
