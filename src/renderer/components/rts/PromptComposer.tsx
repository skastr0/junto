import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { keyIs } from "../../lib/key-match";
import "./prompt-composer.css";

const MIN_ROWS = 2;
const MAX_ROWS = 6;

// Textarea grows with content up to MAX_ROWS, then scrolls. ⌘Enter (or
// Ctrl+Enter) sends; Enter alone inserts a newline. onSend may return false
// (sync/async) to keep the draft (partial multi-fail).
//
// Overlay mode (prompt-composer--overlay): footer, eyebrow, and status float
// over the textarea so a short RTS mid panel never clips the send control.
export function PromptComposer({
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
  const overlay = Boolean(className?.includes("prompt-composer--overlay"));

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
    <div className={["prompt-composer", className].filter(Boolean).join(" ")}>
      {eyebrow ? (
        <span className="prompt-composer__eyebrow" aria-hidden={false}>
          {eyebrow}
        </span>
      ) : null}
      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        rows={MIN_ROWS}
        className="prompt-composer__input"
        placeholder={placeholder}
        value={draft}
        disabled={disabled || sending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (keyIs(event, "message.send")) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="prompt-composer__footer">
        <div className="prompt-composer__tools">
          {status ? (
            <span className="prompt-composer__status" role="status" aria-live="polite">
              {status}
            </span>
          ) : null}
        </div>
        <div className="prompt-composer__submit">
          <span className="prompt-composer__hint">{hint}</span>
          <button
            type="button"
            className="prompt-composer__send"
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
