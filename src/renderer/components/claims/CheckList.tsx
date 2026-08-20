import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { ulid } from "ulid";
import type { CheckDef } from "@shared/work-model";
import { Button, IconButton, Input } from "../ui";

// Boarding checks are the only deterministic checks in the pipeline, and the
// seat runs them: `tasks board` executes each command in the seat's own
// environment and submits the exit code. Vellum Command never schedules or
// runs them itself. Exit 0 is green.

function CheckRow({
  check,
  onChange,
  onRemove,
}: {
  readonly check: CheckDef;
  readonly onChange: (next: CheckDef) => void;
  readonly onRemove: () => void;
}) {
  const [label, setLabel] = useState(check.label);
  const [command, setCommand] = useState(check.command);
  useEffect(() => {
    setLabel(check.label);
    setCommand(check.command);
  }, [check.id, check.label, check.command]);

  const commit = () => {
    const nextLabel = label.trim();
    const nextCommand = command.trim();
    if (!nextLabel || !nextCommand) {
      setLabel(check.label);
      setCommand(check.command);
      return;
    }
    if (nextLabel === check.label && nextCommand === check.command) return;
    onChange({ id: check.id, label: nextLabel, command: nextCommand });
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        data-focus-owner="canvas-draft"
        aria-label="Check name"
        className="min-h-[28px] w-[34%] py-1 text-[11px]"
        value={label}
        placeholder="name"
        onChange={(event) => setLabel(event.target.value)}
        onBlur={commit}
      />
      <Input
        data-focus-owner="canvas-draft"
        aria-label="Check command"
        className="min-h-[28px] py-1 font-mono text-[11px]"
        value={command}
        placeholder="command, exit 0 is green"
        spellCheck={false}
        onChange={(event) => setCommand(event.target.value)}
        onBlur={commit}
      />
      <IconButton
        size="sm"
        tone="danger"
        aria-label="Remove check"
        title="Remove check"
        onClick={onRemove}
      >
        <X size={12} />
      </IconButton>
    </div>
  );
}

/** A check with no command cannot run, so the draft stays local until both fields hold. */
function CheckDraftRow({
  onAdd,
  onCancel,
}: {
  readonly onAdd: (check: CheckDef) => void;
  readonly onCancel: () => void;
}) {
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");

  const commit = () => {
    const nextLabel = label.trim();
    const nextCommand = command.trim();
    if (!nextLabel || !nextCommand) return;
    onAdd({ id: ulid(), label: nextLabel, command: nextCommand });
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        data-focus-owner="canvas-draft"
        aria-label="New check name"
        className="min-h-[28px] w-[34%] py-1 text-[11px]"
        autoFocus
        value={label}
        placeholder="name"
        onChange={(event) => setLabel(event.target.value)}
      />
      <Input
        data-focus-owner="canvas-draft"
        aria-label="New check command"
        className="min-h-[28px] py-1 font-mono text-[11px]"
        value={command}
        placeholder="command, exit 0 is green"
        spellCheck={false}
        onChange={(event) => setCommand(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <Button size="xs" disabled={!label.trim() || !command.trim()} onClick={commit}>
        add
      </Button>
      <IconButton size="sm" aria-label="Discard new check" title="Discard" onClick={onCancel}>
        <X size={12} />
      </IconButton>
    </div>
  );
}

export function CheckList({
  ownerKey,
  checklist,
  hint,
  onChange,
}: {
  readonly ownerKey: string;
  readonly checklist: ReadonlyArray<CheckDef>;
  readonly hint: string;
  readonly onChange: (next: ReadonlyArray<CheckDef>) => void;
}) {
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    setAdding(false);
  }, [ownerKey]);

  return (
    <div className="mt-3">
      <div className="text-[9px] tracking-[0.14em] text-dim uppercase">boarding checks</div>
      <div className="inspector-detail mt-1">{hint}</div>
      {checklist.length > 0 ? (
        <div className="mt-2 grid gap-1.5">
          {checklist.map((check, index) => (
            <CheckRow
              key={check.id}
              check={check}
              onChange={(next) =>
                onChange(checklist.map((item, i) => (i === index ? next : item)))
              }
              onRemove={() => onChange(checklist.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      ) : null}
      {adding ? (
        <div className="mt-1.5">
          <CheckDraftRow
            onAdd={(check) => {
              onChange([...checklist, check]);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <Button
          size="xs"
          className="mt-2"
          aria-label="Add boarding check"
          onClick={() => setAdding(true)}
        >
          <Plus size={11} />
          check
        </Button>
      )}
    </div>
  );
}
