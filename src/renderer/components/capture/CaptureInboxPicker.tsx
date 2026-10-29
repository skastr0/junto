import { useMemo, useState } from "react";
import type { NodeId } from "@shared/physics/schema";
import { makeCaptureInbox } from "../../lib/capture-inbox";
import { useCanvas } from "../../lib/use-model";
import { moveTargets } from "../artifacts/artifact-move-model";
import { radioGroupKeys, radioTabIndex } from "../settings/radio-keys";
import { Button } from "../ui";
import "./capture-inbox.css";

const NO_NODE = "" as NodeId;

/**
 * Quick capture's Inbox choice (11 Q4): the canvas's Artifacts nodes by name
 * and region, one pick, or Make an Inbox. Arrows move through the nodes and
 * Enter or Space picks, since a pick starts a capture. Shared by the first
 * Cmd+T's ask and the Inbox page in Settings, which differ only in what a
 * pick leads to (`onPick`).
 */
export function CaptureInboxPicker({
  canvasName,
  value,
  label,
  onPick,
}: {
  readonly canvasName: string;
  /** The node chosen now, if any: it shows checked. */
  readonly value: string | undefined;
  /** Names the group for assistive tech. */
  readonly label: string;
  readonly onPick: (nodeId: string) => void;
}) {
  const canvas = useCanvas(canvasName);
  const targets = useMemo(() => moveTargets(canvas, NO_NODE), [canvas]);
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tabStop = targets.some((target) => target.id === value) ? value : targets[0]?.id;

  const make = (): void => {
    if (making) return;
    setMaking(true);
    setError(null);
    makeCaptureInbox(canvasName).then(
      (nodeId) => {
        setMaking(false);
        onPick(nodeId);
      },
      (failure: unknown) => {
        setMaking(false);
        setError(failure instanceof Error ? failure.message : "Junto could not add the Inbox. Try again.");
      },
    );
  };

  return (
    <div className="capture-inbox-picker">
      {targets.length === 0 ? (
        <p className="capture-inbox-picker__none">There is no Artifacts node on this canvas yet.</p>
      ) : (
        <div className="capture-inbox-picker__list" role="radiogroup" aria-label={label} onKeyDown={radioGroupKeys(false)}>
          {targets.map((target) => {
            const checked = target.id === value;
            return (
              <button
                key={target.id}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={radioTabIndex(target.id === tabStop)}
                className={checked ? "capture-inbox-picker__row is-active" : "capture-inbox-picker__row"}
                data-node-id={target.id}
                onClick={() => onPick(target.id)}
              >
                <span className="capture-inbox-picker__name">{target.title}</span>
                <span className="capture-inbox-picker__place">{target.place}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="capture-inbox-picker__make">
        <Button variant="primary" aria-disabled={making} onClick={make}>
          Make an Inbox
        </Button>
        <span className="capture-inbox-picker__make-hint">
          Adds an Artifacts node named Inbox at the edge of the canvas.
        </span>
      </div>
      {error ? (
        <p className="capture-inbox-picker__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
