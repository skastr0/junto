import type { CSSProperties, DragEvent, ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import type { Node, Seat } from "@shared/model";
import { titleOf } from "@shared/model/title";
import { groupLabel } from "../../lib/command-groups";
import { rollupToneHex } from "../../lib/minimap-seat-colors";
import { modKeyGlyph } from "../../lib/platform";
import { state$ } from "../../lib/state";
import { modelStore, useNode } from "../../lib/use-model";
import type { SeatRollup } from "../../lib/seat-rollup";
import { KindMark } from "../NodeKindMark";
import { SeatRingView, useSeatGlanceOf } from "../SeatRing";
import "./command-group-bar.css";

/** Faces drawn on one chip before the rest are only counted. */
const FACES_MAX = 3;
/** Ring box for one face on a chip. */
const FACE_PX = 22;

export type CommandGroupTenure = "empty" | "fixed" | "group" | "leased" | "evicted";

/**
 * One member's face. It follows its own node in the store and no other, so a
 * chip is not redrawn because some other card moved.
 */
function ChipFace({ nodeId }: { readonly nodeId: string }) {
  const node = useNode(use$(state$.canvasName), nodeId);
  return node ? <ChipFaceOf node={node} /> : null;
}

/** A seat's live ring: its own component, so only a seat's face follows a seat. */
function SeatFace({ seat }: { readonly seat: Seat }) {
  return <SeatRingView node={seat} px={FACE_PX} glance={useSeatGlanceOf(seat)} />;
}

/** A face for a node already in hand. */
function ChipFaceOf({ node }: { readonly node: Node }) {
  return node.kind === "agent" ? (
    <span className="group-chip__face">
      <SeatFace seat={node} />
    </span>
  ) : (
    <KindMark node={node} className="group-chip__face group-chip__mark" iconSize={11} />
  );
}

function ChipFaces({ count, children }: { readonly count: number; readonly children: ReactNode }) {
  const more = count - Math.min(count, FACES_MAX);
  return (
    <span className="group-chip__faces" aria-hidden>
      {children}
      {more > 0 ? <span className="group-chip__more">+{more}</span> : null}
    </span>
  );
}

/** Split character no title holds. */
const TITLE_SPLIT = "";

/**
 * What the members are called now. The selector answers one string, so the
 * chip is redrawn when a name changes and not when a member only moved.
 */
const useMemberTitles = (memberIds: ReadonlyArray<string>): ReadonlyArray<string> => {
  const joined = use$(() => {
    const canvasName = state$.canvasName.get();
    return memberIds
      .map((id) => {
        const node = modelStore.node$(canvasName, id).get();
        return node === undefined ? id : titleOf(node);
      })
      .join(TITLE_SPLIT);
  });
  return memberIds.length === 0 ? [] : joined.split(TITLE_SPLIT);
};

/**
 * One command group chip: its digit (none past nine), its members' faces in
 * their live rings, a short name, and the group's worst tone as its colour.
 */
export type CommandGroupChipProps = ChipProps;

type ChipProps = {
  /** 1 to 9, or undefined past nine. */
  readonly hotkey: number | undefined;
  readonly testId: string;
  readonly tenure: CommandGroupTenure;
  /** The members the canvas still holds, in the group's order. */
  readonly memberIds: ReadonlyArray<string>;
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
};

/**
 * One command group chip on the live canvas: it follows what its members are
 * called and draws each member's face from that member's own node.
 */
export function CommandGroupChip(props: ChipProps) {
  const titles = useMemberTitles(props.memberIds);
  return (
    <CommandGroupChipView
      {...props}
      titles={titles}
      faces={props.memberIds.slice(0, FACES_MAX).map((id) => (
        <ChipFace key={id} nodeId={id} />
      ))}
    />
  );
}

/** The same chip over nodes a caller scripted, held in no store: the tour's. */
export function ScriptedCommandGroupChip({
  members,
  titles,
  ...props
}: Omit<ChipProps, "memberIds"> & {
  readonly members: ReadonlyArray<Node>;
  readonly titles: ReadonlyArray<string>;
}) {
  return (
    <CommandGroupChipView
      {...props}
      memberIds={members.map((node) => node.id)}
      titles={titles}
      faces={members.slice(0, FACES_MAX).map((node) => (
        <ChipFaceOf key={node.id} node={node} />
      ))}
    />
  );
}

function CommandGroupChipView({
  hotkey,
  testId,
  tenure,
  memberIds,
  titles,
  faces,
  tone,
  selected,
  onActivate,
  onOpen,
  onForget,
  dragProps,
}: ChipProps & { readonly titles: ReadonlyArray<string>; readonly faces: ReactNode }) {
  const mod = modKeyGlyph();
  const label = groupLabel(titles);
  const detail = titles.join(", ");
  const kind =
    tenure === "group"
      ? `group of ${memberIds.length}`
      : tenure === "leased"
        ? "busy, placed automatically"
        : tenure === "evicted"
          ? "idle, yields to new work"
          : "pinned";
  const state = tone ? `, ${tone.reason}` : "";

  if (tenure === "empty" || memberIds.length === 0) {
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
      data-node-id={memberIds.length === 1 ? memberIds[0] : undefined}
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
      <ChipFaces count={memberIds.length}>{faces}</ChipFaces>
      <span className="group-chip__label">{label}</span>
    </button>
  );
}
