import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { SeatGuidance } from "@shared/seat-guidance";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { saveSeatGuidance, seatGuidance$, startSeatGuidance } from "../../lib/seat-guidance-state";
import { Textarea } from "../ui/Field";
import "./customize.css";

/** Quiet after this long without a keystroke, the text is saved. */
const SAVE_AFTER_MS = 700;

type Field = keyof SeatGuidance;

/**
 * One operator-authored field of a seat's guidance (soul or instructions):
 * markdown in a textarea that saves itself shortly after typing stops, on
 * blur, and when the editor closes around it. The bound is shown as it nears
 * and refused past it, never cut silently.
 */
export function GuidanceField({
  seatId,
  field,
  label,
  max,
  placeholder,
  children,
}: {
  readonly seatId: string;
  readonly field: Field;
  readonly label: string;
  readonly max: number;
  readonly placeholder: string;
  /** What the text is for and where it reaches the agent. */
  readonly children: React.ReactNode;
}) {
  useEffect(startSeatGuidance, []);
  const saved = use$(() => seatGuidance$[seatId].get()?.[field] ?? "");
  const [draft, setDraft] = useState(saved);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<{ readonly tone: "quiet" | "error"; readonly text: string }>({
    tone: "quiet",
    text: "",
  });
  const timer = useRef<number | undefined>(undefined);
  const input = useRef<HTMLTextAreaElement | null>(null);

  // Follow the saved text (another window, a profile placed onto this seat)
  // while the operator is not typing here.
  useEffect(() => {
    if (!editing) setDraft(saved);
  }, [saved, editing]);

  const over = draft.trim().length > max;

  const save = async (text: string): Promise<void> => {
    window.clearTimeout(timer.current);
    if (text.trim().length > max) return;
    const current = seatGuidance$[seatId].peek() ?? {};
    if ((current[field] ?? "") === text.trim()) {
      setEditing(false);
      return;
    }
    const reason = await saveSeatGuidance(seatId, { ...current, [field]: text });
    setEditing(false);
    setStatus(reason ? { tone: "error", text: reason } : { tone: "quiet", text: "Saved" });
  };

  // The editor closes on an outside press or Escape before the field blurs,
  // so pending typing is saved on unmount.
  const latest = useRef({ draft, editing, save });
  latest.current = { draft, editing, save };
  useEffect(
    () => () => {
      const { draft: text, editing: typing, save: keep } = latest.current;
      if (typing) void keep(text);
    },
    [],
  );

  const length = draft.trim().length;
  const showCount = length > max * 0.8;

  return (
    <div className="customize-guidance">
      <label className="agent-editor__field">
        <span className="agent-editor__field-label">{label}</span>
        <Textarea
          ref={(element) => {
            if (element && !input.current) claimFocusOnMount(element);
            input.current = element;
          }}
          value={draft}
          placeholder={placeholder}
          spellCheck
          aria-label={`${label} for this agent`}
          aria-invalid={over || undefined}
          data-testid={`agent-editor-${field}`}
          className="customize-guidance__text"
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            setEditing(true);
            setStatus({ tone: "quiet", text: "" });
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => void save(text), SAVE_AFTER_MS);
          }}
          onBlur={() => {
            if (editing) void save(draft);
          }}
        />
      </label>
      <div className="customize-guidance__foot">
        {over ? (
          <span className="customize-guidance__error" role="alert">
            {length} of {max} characters; shorten it to save
          </span>
        ) : status.text ? (
          <span className={status.tone === "error" ? "customize-guidance__error" : "customize-guidance__status"} role={status.tone === "error" ? "alert" : "status"}>
            {status.text}
          </span>
        ) : (
          <span />
        )}
        {showCount && !over ? <span className="customize-guidance__count">{length} / {max}</span> : null}
      </div>
      <p className="agent-editor__hint">{children}</p>
    </div>
  );
}
