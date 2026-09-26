import { useEffect, useRef, useState } from "react";
import { claimFocusAndSelectOnMount } from "../../lib/focus-ownership";
import { renameTerminalNode } from "../../lib/mutations";
import { Input } from "../ui";
import type { AgentEditorSectionProps } from "./sections";

// Name: the seat's name on the canvas, in the focus view, and in every list
// that names it. Commits on Enter, when the field loses focus, or when the
// editor closes around it; Escape drops the typing. Empty is never a name.

export const AGENT_NAME_MAX = 64;

export function NameSection({ seat }: AgentEditorSectionProps) {
  const [value, setValue] = useState(seat.name);
  // True from the first keystroke until the typing is settled.
  const [editing, setEditing] = useState(false);
  // Follow renames made elsewhere (inline on the card) while not typing.
  useEffect(() => {
    if (!editing) setValue(seat.name);
  }, [seat.name, editing]);

  const commit = (text: string): void => {
    const next = text.trim();
    if (next && next !== seat.name) renameTerminalNode(seat.id, next);
  };
  const settle = (): void => {
    setEditing(false);
    if (value.trim()) commit(value);
    else setValue(seat.name);
  };

  // The editor closes on an outside press or Escape before the field blurs,
  // so the typing is settled on unmount: kept, unless Escape dropped it.
  const latest = useRef({ value, editing, commit, dropped: false });
  latest.current = { ...latest.current, value, editing, commit };
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // The modal closes a microtask after Escape, so this still sees the key.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.activeElement === input.current) latest.current.dropped = true;
    };
    // focus-law: Escape-only, marks the typing dropped; never a shortcut.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      const { value: text, editing: typing, commit: keep, dropped } = latest.current;
      if (typing && !dropped) keep(text);
    };
  }, []);

  return (
    <div className="agent-editor__name-section">
      <label className="agent-editor__field">
        <span className="agent-editor__field-label">name</span>
        <Input
          ref={(element) => {
            if (element && !input.current) claimFocusAndSelectOnMount(element);
            input.current = element;
          }}
          value={value}
          maxLength={AGENT_NAME_MAX}
          spellCheck={false}
          aria-label="Agent name"
          data-testid="agent-editor-name"
          onChange={(event) => {
            setEditing(true);
            setValue(event.target.value);
          }}
          onBlur={() => editing && settle()}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            settle();
          }}
        />
      </label>
      <p className="agent-editor__hint">
        Shown on the seat, in its focus view, and wherever the agent is named. Renaming keeps the look.
      </p>
    </div>
  );
}
