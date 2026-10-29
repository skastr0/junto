import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { FolderInput } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import type { ItemId } from "@shared/resource-command";
import { applyArtifactOp } from "../../lib/artifacts-source";
import { claimFocus } from "../../lib/focus-ownership";
import { useCanvas } from "../../lib/use-model";
import { Button, Combobox, Dialog, Popover } from "../ui";
import { matchTargets, moveTargets, reachChange, reachLine, type MoveTarget } from "./artifact-move-model";

/** What the picker moves: each artifact by id, with the title its lines name it by. */
export type MovingArtifact = { readonly artifactId: ItemId; readonly title: string };

/** What a move that left nothing behind says to the node. */
export type MoveDone = { readonly titles: ReadonlyArray<string>; readonly queued: number; readonly to: MoveTarget };

const NO_ANSWER = "Junto got no answer for that move. Try again.";

/**
 * Move to (0.11.1, 10 M2): the canvas's other Artifacts nodes by name and
 * region, filtered as the operator types; arrows or a press pick one, Enter,
 * a double press or Move moves there. A pick in another region shows the one
 * confirm line naming whose reach changes before anything moves, and no
 * other dialog follows: a press never moves there, a double press only picks,
 * and Enter or Move moves. Each artifact is one move, ruled on its own: a
 * refusal stays here, said, and Move tries only what did not move. While a
 * move runs, Escape and the backdrop wait for it.
 */
export function ArtifactMoveDialog({
  canvasName,
  from,
  artifacts,
  onDone,
  onCancel,
}: {
  readonly canvasName: string;
  /** The node they are on: left out of the list. */
  readonly from: NodeId;
  readonly artifacts: ReadonlyArray<MovingArtifact>;
  readonly onDone: (done: MoveDone) => void;
  readonly onCancel: () => void;
}) {
  const canvas = useCanvas(canvasName);
  const targets = useMemo(() => moveTargets(canvas, from), [canvas, from]);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState<string | undefined>(undefined);
  /** Still to move: a retry after a refusal names only these. */
  const [left, setLeft] = useState(artifacts);
  const [moved, setMoved] = useState<{ readonly titles: ReadonlyArray<string>; readonly queued: number }>({ titles: [], queued: 0 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => matchTargets(targets, typed), [targets, typed]);
  const picked = shown.find((target) => target.id === active);
  const line = picked === undefined ? null : reachLine(reachChange(canvas, from, picked.id), left.length);

  const move = async (to: MoveTarget): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const titles = [...moved.titles];
    let queued = moved.queued;
    const refused: Array<{ readonly artifact: MovingArtifact; readonly reason: string }> = [];
    for (const artifact of left) {
      try {
        const ruling = await applyArtifactOp(canvasName, from, artifact.artifactId, { op: "move", to: to.id });
        if (ruling.kind === "refused") refused.push({ artifact, reason: ruling.error.message });
        else {
          titles.push(artifact.title);
          if (ruling.kind === "queued") queued += 1;
        }
      } catch {
        refused.push({ artifact, reason: NO_ANSWER });
      }
    }
    setBusy(false);
    if (refused.length === 0) return onDone({ titles, queued, to });
    setMoved({ titles, queued });
    setLeft(refused.map(({ artifact }) => artifact));
    const [first] = refused;
    setError(
      refused.length === 1
        ? `${first!.artifact.title} was not moved: ${first!.reason}`
        : `${String(refused.length)} were not moved. ${first!.artifact.title}: ${first!.reason}`,
    );
  };

  /**
   * Enter or a double press moves to the picked node. With nothing picked, a
   * list of one picks it, so its reach line shows before it moves.
   */
  const commit = (target: MoveTarget | undefined): void => {
    if (target !== undefined) return void move(target);
    if (shown.length === 1) setActive(shown[0]!.id);
  };

  /** A double press moves only where no reach changes; elsewhere it picks, so the line is read first. */
  const doublePress = (target: MoveTarget): void => {
    if (reachLine(reachChange(canvas, from, target.id), left.length) === null) void move(target);
    else setActive(target.id);
  };

  const one = left.length === 1 ? left[0]!.title : undefined;
  return (
    <Dialog
      title={one === undefined ? `Move ${String(left.length)} artifacts` : `Move ${one}`}
      eyebrow="Move to"
      width={480}
      onClose={() => {
        if (!busy) onCancel();
      }}
      actions={
        <>
          <Button variant="chrome" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" aria-disabled={busy || picked === undefined} onClick={() => commit(picked)}>
            Move
          </Button>
        </>
      }
    >
      <div className="artifact-move">
        <Combobox<MoveTarget>
          aria-label={one === undefined ? `Artifacts node to move ${String(left.length)} artifacts to` : `Artifacts node to move ${one} to`}
          listLabel="Artifacts nodes"
          placeholder="Type a node or a region, or pick one"
          value={typed}
          onValueChange={(value) => {
            setTyped(value);
            setError(null);
          }}
          options={shown}
          optionKey={(target) => target.id}
          renderOption={(target) => (
            <span className="artifact-move__target">
              <span className="artifact-move__name">{target.title}</span>
              <span className="artifact-move__place">{target.place}</span>
            </span>
          )}
          activeKey={active}
          onActiveKeyChange={setActive}
          onCommit={(target) => commit(target)}
          onOptionClick={(target) => setActive(target.id)}
          onOptionDoubleClick={doublePress}
          empty={
            <p className="artifact-move__none">
              {targets.length === 0 ? "There is no other Artifacts node on this canvas." : "No Artifacts node by that name or region."}
            </p>
          }
        />
        {/* The confirm line: said as the pick lands on a node in another region, before Enter moves. */}
        <p className="artifact-move__reach" role="status">
          {line ?? ""}
        </p>
        {error ? (
          <p className="artifact-move__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * A sidebar row's menu (0.11.1, 10 M2): opened by a right-click, Shift+F10
 * or the Menu key on a row, focus on its first item. Arrows, Home and End
 * move; Escape and Tab close and give focus back to the row; a press
 * outside only closes. Move to takes the whole selection when the row is in
 * one of several.
 */
export function ArtifactRowMenu({
  anchor,
  count,
  onMove,
  onClose,
}: {
  readonly anchor: HTMLElement;
  /** How many rows Move to takes from here. */
  readonly count: number;
  readonly onMove: () => void;
  /** `refocus`: give focus back to the row once the menu is gone. */
  readonly onClose: (refocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const done = useRef(onClose);
  done.current = onClose;
  // Heard ahead of the popover's own keys, as the swatch menu's are (LabelColourMenu).
  useLayoutEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" || (event.key === "Tab" && menu.current?.contains(document.activeElement) === true)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        done.current(true);
      }
    };
    // focus-law: Escape and Tab close the open row menu, never a typing shortcut.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === "ArrowDown"
        ? (at + 1) % items.length
        : event.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    claimFocus(items[to], "gesture", { event: event.nativeEvent });
  };
  const label = count > 1 ? `Actions for ${String(count)} artifacts` : "Actions for this artifact";
  return (
    <Popover anchor={anchor} onClose={() => onClose(false)} label={label} sides={["below", "above"]} align="center" width={200} className="artifact-row-menu">
      <div ref={menu} role="menu" aria-label={label} onKeyDown={keys}>
        <button
          type="button"
          role="menuitem"
          tabIndex={0}
          data-autofocus=""
          className="artifact-row-menu__item"
          onClick={() => {
            // The row takes the keyboard first, so it is the picker's opener and gets it back on Cancel.
            onClose(true);
            onMove();
          }}
        >
          <FolderInput size={14} aria-hidden />
          {count > 1 ? `Move ${String(count)} to…` : "Move to…"}
        </button>
      </div>
    </Popover>
  );
}
