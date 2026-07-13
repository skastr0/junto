import { useEffect, useRef, useState } from "react";

export interface ChatContextBlock {
  readonly label: string;
  readonly text: string;
}

const MIN_ROWS = 2;
const MAX_ROWS = 6;

// Textarea grows with content up to MAX_ROWS, then scrolls. ⌘Enter (or
// Ctrl+Enter) sends; Enter alone inserts a newline like every other chat UI.
export function ChatComposer({
  contextBlocks = [],
  onSend,
}: {
  readonly contextBlocks?: ReadonlyArray<ChatContextBlock>;
  readonly onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight || "14") || 14;
    const maxHeight = lineHeight * MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [draft]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className="chat-composer">
      {contextBlocks.length > 0 ? (
        <div className="chat-context-chips">
          {contextBlocks.map((block, index) => (
            <span key={`${block.label}-${index}`} className="chat-context-chip" title={block.text}>{block.label}</span>
          ))}
        </div>
      ) : null}
      <div className="chat-composer__row">
        <textarea
          ref={textareaRef}
          aria-label="Message"
          rows={MIN_ROWS}
          className="chat-composer__input"
          placeholder="message the agent… (⌘⏎ to send)"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="chat-composer__send" disabled={!draft.trim()} onClick={send}>send</button>
      </div>
    </div>
  );
}
