import { useEffect, useState } from "react";
import { ulid } from "ulid";
import type { CanvasNode } from "@shared/canvas";
import type { Check, Rule, TaskAdmission, TasksContract } from "@shared/work-model";
import { resolveTaskAdmission } from "@shared/work-model";
import { setBoardSettings } from "../../lib/mutations";
import { admissionChoiceLabel, ADMISSION_ORDER } from "../../lib/admission-labels";
import { ChecksEditor } from "./ChecksEditor";
import { RuleList } from "./RuleList";
import { RequiresReviewControl } from "../work/RequiresReviewControl";
import { boardReviewGate, withRequiresReviewRule } from "../../lib/crew-review-view";
import { formatWait, normalizeBoardSettings, parseWait } from "./board-settings";
import { Select } from "../ui";

function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="inspector-editor">
      <span>{label}</span>
      <textarea
        data-focus-owner="canvas-draft"
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft.trim() !== value.trim() && onCommit(draft)}
      />
    </label>
  );
}

export function BoardSettings({
  node,
  focusSide,
}: {
  readonly node: CanvasNode;
  readonly focusSide?: "incoming" | "outgoing";
}) {
  if (node.ether?.entity?.kind !== "task") return null;
  const contract = node.ether.tasks?.contract;
  const write = (next: TasksContract) =>
    setBoardSettings(node.id, normalizeBoardSettings(next));
  const [wait, setWait] = useState(formatWait(contract?.incoming?.waitMs));
  useEffect(
    () => setWait(formatWait(contract?.incoming?.waitMs)),
    [contract?.incoming?.waitMs, node.id],
  );
  const incoming = contract?.incoming;
  const outgoing = contract?.outgoing;
  return (
    <>
      <TextField
        label="Instructions"
        value={contract?.instructions ?? ""}
        placeholder="What is this board for?"
        onCommit={(instructions) => write({ ...contract, instructions })}
      />
      <RuleList
        rules={contract?.rules ?? []}
        label="This board's rules"
        hint="Answered by whoever completes work here."
        onChange={(rules: ReadonlyArray<Rule>) => write({ ...contract, rules })}
      />
      <RequiresReviewControl
        gate={boardReviewGate(contract)}
        editable
        onChange={(required) =>
          write({
            ...contract,
            rules: withRequiresReviewRule(contract?.rules ?? [], required, ulid),
          })
        }
      />
      {focusSide !== "outgoing" ? (
        <div className="inspector-section">
          <div className="inspector-section__label">Incoming</div>
          <label className="inspector-editor">
            <span>Who starts tasks</span>
            <Select
              dense
              aria-label="Who starts tasks"
              value={resolveTaskAdmission(contract)}
              options={ADMISSION_ORDER.map((value) => ({
                value,
                label: admissionChoiceLabel(value),
              }))}
              onChange={(admission) =>
                write({
                  ...contract,
                  incoming: {
                    ...incoming,
                    admission: admission as TaskAdmission,
                  },
                })
              }
            />
          </label>
          <label className="inspector-editor">
            <span>Wait before starting</span>
            <input
              aria-label="Wait before starting"
              value={wait}
              placeholder="e.g. 90m, 12h, 7d"
              onChange={(event) => setWait(event.target.value)}
              onBlur={() => {
                const parsed = parseWait(wait);
                if (parsed.ok) {
                  write({
                    ...contract,
                    incoming: { ...incoming, waitMs: parsed.ms },
                  });
                }
              }}
            />
          </label>
          <TextField
            label="Handling"
            value={incoming?.handling ?? ""}
            placeholder="How should new tasks be handled here?"
            onCommit={(handling) =>
              write({ ...contract, incoming: { ...incoming, handling } })
            }
          />
          <TextField
            label="What this board takes"
            value={incoming?.description ?? ""}
            placeholder="What kind of work belongs here?"
            onCommit={(description) =>
              write({ ...contract, incoming: { ...incoming, description } })
            }
          />
          <ChecksEditor
            ownerKey={`${node.id}:incoming`}
            checks={incoming?.checks ?? []}
            label="Checks on entry"
            hint="Commands run when a task enters this board. Exit 0 passes."
            onChange={(checks: ReadonlyArray<Check>) =>
              write({ ...contract, incoming: { ...incoming, checks } })
            }
          />
        </div>
      ) : null}
      {focusSide !== "incoming" ? (
        <div className="inspector-section">
          <div className="inspector-section__label">Outgoing</div>
          <TextField
            label="Handoff note"
            value={outgoing?.handoff ?? ""}
            placeholder="What should the next board know?"
            onCommit={(handoff) =>
              write({ ...contract, outgoing: { ...outgoing, handoff } })
            }
          />
          <TextField
            label="What this board sends"
            value={outgoing?.description ?? ""}
            placeholder="What kind of work leaves here?"
            onCommit={(description) =>
              write({ ...contract, outgoing: { ...outgoing, description } })
            }
          />
          <ChecksEditor
            ownerKey={`${node.id}:outgoing`}
            checks={outgoing?.checks ?? []}
            label="Checks on exit"
            hint="Commands run before a task leaves this board. Exit 0 passes."
            onChange={(checks: ReadonlyArray<Check>) =>
              write({ ...contract, outgoing: { ...outgoing, checks } })
            }
          />
        </div>
      ) : null}
    </>
  );
}
