import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { ulid } from "ulid";
import type { Rule } from "@shared/work-model";
import { Button, IconButton, Input } from "../ui";

function RuleRow({ rule, onChange, onRemove }: {
  readonly rule: Rule;
  readonly onChange: (next: Rule) => void;
  readonly onRemove: () => void;
}) {
  const [draft, setDraft] = useState(rule.text);
  useEffect(() => setDraft(rule.text), [rule.id, rule.text]);
  const commit = () => {
    const text = draft.trim();
    if (text && text !== rule.text) onChange({ ...rule, text });
    else setDraft(rule.text);
  };
  return <div className="flex items-center gap-1.5">
    <Input data-focus-owner="canvas-draft" aria-label="Rule text"
      className="min-h-[28px] py-1 text-[11px]" value={draft}
      placeholder="what must be true before this closes?"
      onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); }
        if (event.key === "Escape") { setDraft(rule.text); event.currentTarget.blur(); }
      }} />
    <IconButton size="sm" tone="danger" aria-label="Remove rule" title="Remove rule" onClick={onRemove}>
      <X size={12} />
    </IconButton>
  </div>;
}

export function RuleList({ rules, label, hint, onChange }: {
  readonly rules: ReadonlyArray<Rule>;
  readonly label: string;
  readonly hint?: string;
  readonly onChange: (next: ReadonlyArray<Rule>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim();
    if (text) onChange([...rules, { id: ulid(), text }]);
    setDraft(""); setAdding(false);
  };
  return <div className="inspector-section">
    <div className="inspector-section__label">{label}</div>
    {hint ? <div className="inspector-detail mt-1">{hint}</div> : null}
    {rules.length > 0 ? <div className="mt-2 grid gap-1.5">{rules.map((rule, index) =>
      <RuleRow key={rule.id} rule={rule}
        onChange={(next) => onChange(rules.map((entry, i) => i === index ? next : entry))}
        onRemove={() => onChange(rules.filter((_, i) => i !== index))} />
    )}</div> : null}
    {adding ? <div className="mt-2 flex items-center gap-1.5">
      <Input autoFocus data-focus-owner="canvas-draft" aria-label="New rule text" value={draft}
        placeholder="what must be true before this closes?"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") add(); if (event.key === "Escape") setAdding(false); }} />
      <IconButton size="sm" aria-label="Discard new rule" onClick={() => setAdding(false)}><X size={12} /></IconButton>
    </div> : null}
    <Button size="xs" className="mt-2" aria-label="Add rule" onClick={() => setAdding(true)}>
      <Plus size={11} /> add rule
    </Button>
  </div>;
}
