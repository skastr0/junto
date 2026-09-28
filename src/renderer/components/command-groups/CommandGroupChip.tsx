import type { CSSProperties, DragEvent } from "react";
import type { CanvasNode } from "@shared/canvas";
import { groupLabel } from "../../lib/command-groups";
import { rollupToneHex } from "../../lib/minimap-seat-colors";
import { modKeyGlyph } from "../../lib/platform";
import { nodeTitle } from "../../lib/presentation";
import type { SeatRollup } from "../../lib/seat-rollup";
import { NodeKindMark } from "../NodeKindMark";
import { SeatRing } from "../SeatRing";
import "./command-group-bar.css";

/** Faces drawn on one chip before the rest are only counted. */
const FACES_MAX = 3;
/** Ring box for one face on a chip. */
const FACE_PX = 22;

export type CommandGroupTenure = "empty" | "fixed" | "group" | "leased" | "evicted";

const isAgentSeat = (node: CanvasNode): boolean =>
  node.type !== "group" && node.ether?.entity?.kind === "agent";

function ChipFaces({ members }: { readonly members: ReadonlyArray<CanvasNode> }) {
  const shown = members.slice(0, FACES_MAX);
  const more = members.length - shown.length;
  return (
    <span className="group-chip__faces" aria-hidden>
      {shown.map((node) =>
        isAgentSeat(node) ? (
          <span key={node.id} className="group-chip__face">
            <SeatRing node={node} px={FACE_PX} />
          </span>
        ) : (
          <NodeKindMark key={node.id} node={node} className="group-chip__face group-chip__mark" iconSize={11} />
        ),
      )}
      {more > 0 ? <span className="group-chip__more">+{more}</span> : null}
    </span>
  );
}

/**
 * One command group chip: its digit (none past nine), its members' faces in
 * their live rings, a short name, and the group's worst tone as its colour.
 */
export function CommandGroupChip({
  hotkey,
  testId,
  tenure,
  members,
  tone,
  selected,
  onActivate,
  onOpen,
  onForget,
  dragProps,
}: {
  /** 1 to 9, or undefined past nine. */
  readonly hotkey: number | undefined;
  readonly testId: string;
  readonly tenure: CommandGroupTenure;
  readonly members: ReadonlyArray<CanvasNode>;
  readonly tone: SeatRollup | undefined;
  readonly selected: boolean;
  readonly onActivate?: () => void;
  readonly onOpen?: () => void;
  /** Past nine only: right-click forgets the group. */
  readonly onForget?: () => void;
  readonly dragProps?: {
    readonly draggable: boolean;
    readonly onDragStart: () => void;
    readonly onDragOver: (event: DragEvent) => void;
    readonly onDrop: () => void;
  };
}) {
  const mod = modKeyGlyph();
  const titles = members.map(nodeTitle);
  const label = groupLabel(titles);
  const detail = titles.join(", ");
  const kind =
    tenure === "group"
      ? `group of ${members.length}`
      : tenure === "leased"
        ? "busy, placed automatically"
        : tenure === "evicted"
          ? "idle, yields to new work"
          : "pinned";
  const state = tone ? `, ${tone.reason}` : "";

  if (tenure === "empty" || members.length === 0) {
    return (
      <button
        type="button"
        className="group-chip"
        data-tenure="empty"
        data-testid={testId}
        aria-label={`Slot ${hotkey}: empty. ${mod}${hotkey} saves the selection here`}
        title={`Empty slot ${hotkey}. ${mod}${hotkey} saves the selection here`}
        {...dragProps}
      >
        <span className="group-chip__key">{hotkey}</span>
      </button>
    );
  }

  const style = tone
    ? ({ "--chip-tone": rollupToneHex(tone.tone) } as CSSProperties)
    : undefined;
  const name = hotkey === undefined ? "Group" : `Slot ${hotkey}`;
  const recall =
    hotkey === undefined
      ? "Click to select. Drag onto a numbered slot to give it that key. Right-click to forget it."
      : tenure === "group"
        ? `Press ${hotkey} to select, again to open each`
        : `Press ${hotkey} to select, twice to open`;
  return (
    <button
      type="button"
      className="group-chip"
      data-tenure={tenure}
      data-tone={tone?.tone}
      data-stale={tone?.stale ? "true" : undefined}
      data-hotkey={hotkey ?? "none"}
      data-node-id={members.length === 1 ? members[0]!.id : undefined}
      data-testid={testId}
      style={style}
      aria-pressed={selected}
      aria-label={`${name}: ${tenure === "group" ? detail : label}, ${kind}${state}`}
      title={`${detail}. ${kind[0]!.toUpperCase()}${kind.slice(1)}${state}. ${recall}`}
      onClick={onActivate}
      onDoubleClick={(event) => {
        event.preventDefault();
        onOpen?.();
      }}
      onContextMenu={
        onForget
          ? (event) => {
              event.preventDefault();
              onForget();
            }
          : undefined
      }
      {...dragProps}
    >
      {hotkey !== undefined ? <span className="group-chip__key">{hotkey}</span> : null}
      <ChipFaces members={members} />
      <span className="group-chip__label">{label}</span>
    </button>
  );
}
