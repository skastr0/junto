import { useState } from "react";
import { use$ } from "@legendapp/state/react";
import { isTaskPathVerb, type Verb } from "@shared/physics";
import { titleOf } from "@shared/model/title";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { reverbed } from "../../lib/model-edits";
import { commitCommands } from "../../lib/mutations";
import { ResourceGlyphMark } from "../ui";
import "./board-targets.css";

type TargetVerb = "flows" | "derives";

const MODES: ReadonlyArray<{ readonly verb: TargetVerb; readonly label: string }> = [
  { verb: "flows", label: "Flows" },
  { verb: "derives", label: "Derives" },
];

/** The rule main refused with, without the transport's wrapping or an error name before it. */
const plainReason = (message: string): string =>
  message.replace(/^Error invoking remote method '[^']*':\s*/u, "").replace(/^(?:\w*Error|\w*Refused|FiberFailure):\s*/u, "");

const consequence = (verb: TargetVerb, target: string): string =>
  verb === "flows"
    ? `The task moves to ${target} when it finishes here.`
    : `Finishing here creates a new task in ${target}, in backlog with no assignee. This task stays done and lists it.`;

/**
 * The boards this board sends work to: its outgoing task wires. Each one is
 * how the work goes on, and the toggle rewrites that wire's verb. Main refuses
 * a toggle that would close a loop, and the refusal is shown under the row it
 * came from.
 */
export function BoardTargets({ nodeId }: { readonly nodeId: string }) {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
  const [refusal, setRefusal] = useState<{ readonly wire: string; readonly reason: string } | undefined>(undefined);
  const targets = [...canvas.wires.values()].flatMap((wire) => {
    const to = canvas.nodes.get(wire.to);
    if (wire.from !== nodeId || to?.kind !== "task" || !isTaskPathVerb(wire.verb)) return [];
    return [{ wire: wire.id as string, verb: wire.verb, name: titleOf(to) }];
  });
  if (targets.length === 0) return null;

  const choose = (wire: string, verb: Verb): void => {
    setRefusal(undefined);
    commitCommands((current) => reverbed(current, wire, verb), {
      onRefused: (reason) => setRefusal({ wire, reason: plainReason(reason) }),
    });
  };

  return (
    <div className="inspector-section" data-testid="board-targets">
      <div className="inspector-section__label">Targets</div>
      <p className="board-targets__hint">
        Boards downstream of this one. Flows moves the task on. Derives creates a new task there and links it back.
      </p>
      <ul className="board-targets" aria-label="Targets">
        {targets.map((target) => (
          <li key={target.wire} className="board-targets__row">
            <span className="board-targets__name">
              <ResourceGlyphMark kind="task" size={12} />
              <span className="board-targets__title">{target.name}</span>
            </span>
            <div className="board-targets__modes" role="radiogroup" aria-label={`How work reaches ${target.name}`}>
              {MODES.map((mode) => (
                <button
                  key={mode.verb}
                  type="button"
                  role="radio"
                  aria-checked={target.verb === mode.verb}
                  tabIndex={target.verb === mode.verb ? 0 : -1}
                  className="board-targets__mode"
                  onClick={() => target.verb !== mode.verb && choose(target.wire, mode.verb)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const other = MODES.find((candidate) => candidate.verb !== target.verb);
                    if (other) choose(target.wire, other.verb);
                  }}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <p className="board-targets__consequence">{consequence(target.verb, target.name)}</p>
            {refusal?.wire === target.wire ? (
              <p className="board-targets__refusal" role="alert">
                {refusal.reason}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
