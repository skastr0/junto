/**
 * The canvas's context menus (docs/canvas-gpu-architecture.md, section 16):
 * the add deck, the seat menu, the connect menu and the multi-select menu,
 * drawn over the canvas and wired to the same writers the DOM menus call.
 *
 * Nothing here imports React Flow: the seat is read from the model, the
 * selection from `state$`, and placement from the screen point the pointer
 * machine reported. The add deck is the extracted field deck
 * (CanvasFieldTools.tsx), so a new item lands by the same placement rules as
 * "add item" beside the field.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import {
  BookmarkPlus,
  LayoutGrid,
  Link2,
  MessageSquare,
  Pencil,
  ScrollText,
  SquareDashed,
  Trash2,
  Unlink,
  UserRoundPen,
  Users,
} from "lucide-react";
import { AGENT_NODE_SIZE } from "@shared/node-geometry";
import { titleOf } from "@shared/model/title";
import type { Node as ModelNode } from "@shared/model/kinds";
import { connectAllToTarget, connectMesh, disconnectWithin } from "../../lib/edge-mutations";
import { addNode, deleteNodes } from "../../lib/mutations";
import { topZ } from "../../lib/model-edits";
import { newRegion } from "../../lib/model-factories";
import { openAgentEditor } from "../../lib/agent-editor-state";
import { openSaveProfile } from "../../lib/profiles-state";
import { claimFocus, recentGestureKind } from "../../lib/focus-ownership";
import { placeAtPoint, placeBesideRect, type ScreenRect } from "../../lib/menu-placement";
import { useMenuDismiss } from "../../lib/menu-dismiss";
import { seatIdsAmong } from "../../lib/multi-selection";
import { openSaveSquad } from "../../lib/squads-state";
import { saveSelectionToCommandGroup } from "../../lib/command-group-runtime";
import { state$ } from "../../lib/state";
import { openTerminalGrid } from "../../lib/terminal-grid-state";
import { modelStore } from "../../lib/use-model";
import { useContentCalls } from "../../lib/content-calls";
import { makeAddActions, ModeDeckFocus } from "../../components/CanvasFieldTools";
import { SeatMessageForm } from "../../components/nodes/SeatMessage";
import { SeatOffboardMenuRows } from "../../components/nodes/SeatOffboard";
import { SaveToGroupPicker } from "../../components/rts/SaveToGroupPicker";
import { canvasMenu$, closeCanvasMenu, type CanvasMenuState } from "./canvas-menu";

const MENU_ITEMS = "button:not(:disabled)";
const GAP = 8;
const MARGIN = 8;

type Row = {
  readonly key: string;
  readonly label: string;
  readonly detail?: string;
  readonly ariaLabel: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
};

/** A canvas menu worked by keyboard: Escape closes, arrows, Home and End walk the rows. */
const useMenuKeys = (
  menuRef: React.RefObject<HTMLDivElement | null>,
  shown: boolean,
  onClose: () => void,
): ((event: React.KeyboardEvent) => void) => {
  useEffect(() => {
    if (!shown || recentGestureKind() !== "key") return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    claimFocus(menuRef.current?.querySelector<HTMLElement>(MENU_ITEMS), "open");
    return () => {
      const held = document.activeElement;
      if (opener?.isConnected && (held === null || held === document.body)) claimFocus(opener, "open");
    };
  }, [menuRef, shown]);
  return (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step === 0 && event.key !== "Home" && event.key !== "End") return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home" ? 0
      : event.key === "End" ? rows.length - 1
      : at === -1 ? (step === 1 ? 0 : rows.length - 1)
      : (at + step + rows.length) % rows.length;
    claimFocus(rows[next], "gesture", { event: event.nativeEvent });
  };
};

const MenuRow = ({ row }: { readonly row: Row }) => (
  <button aria-label={row.ariaLabel} disabled={row.disabled} onClick={row.onSelect}>
    <span className="canvas-action-menu__icon" aria-hidden>{row.icon}</span>
    <span><strong>{row.label}</strong>{row.detail ? <small>{row.detail}</small> : null}</span>
  </button>
);

const screenRectAt = (screen: { readonly x: number; readonly y: number }): ScreenRect => ({
  left: screen.x,
  top: screen.y,
  right: screen.x,
  bottom: screen.y,
});

/** A menu at a right-click point, or beside a marquee's screen box. */
function MenuHost({
  menu,
  label,
  anchor,
  children,
  onClose,
}: {
  readonly menu: CanvasMenuState;
  readonly label: string;
  readonly anchor?: ScreenRect;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  useMenuDismiss(true, onClose);
  const onKeyDown = useMenuKeys(menuRef, position !== null, onClose);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const size = { width: host.offsetWidth, height: host.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPosition(
      anchor === undefined
        ? placeAtPoint(menu.screen, size, viewport)
        : placeBesideRect(anchor, size, viewport),
    );
  }, [anchor, menu.screen, label]);
  return (
    <div
      ref={hostRef}
      className="canvas-action-menu-host"
      data-canvas-menu-surface
      style={{ position: "fixed", left: position?.x ?? 0, top: position?.y ?? 0, zIndex: 40, visibility: position ? "visible" : "hidden" }}
    >
      <div ref={menuRef} className="canvas-action-menu" role="toolbar" aria-orientation="vertical" aria-label={label} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}

const canvasNodes = (): ReadonlyArray<ModelNode> => {
  const name = state$.canvasName.peek();
  return name === "" ? [] : [...modelStore.canvasOf(name).nodes.values()];
};

const nodeOf = (id: string): ModelNode | undefined => canvasNodes().find((node) => node.id === id);

/** The add deck at the board point that asked for it, centred as the menu placed it. */
function PaneMenu({ menu }: { readonly menu: Extract<CanvasMenuState, { readonly kind: "pane" }> }) {
  const content = useContentCalls();
  const positionFor = (size: { readonly width: number; readonly height: number }) => ({
    x: Math.round(menu.at.x - size.width / 2),
    y: Math.round(menu.at.y - size.height / 2),
  });
  const actions = makeAddActions(positionFor, closeCanvasMenu, content);
  return <ModeDeckFocus actions={actions} agentPosition={positionFor(AGENT_NODE_SIZE)} onClose={closeCanvasMenu} />;
}

function SeatMenu({ menu }: { readonly menu: Extract<CanvasMenuState, { readonly kind: "seat" }> }) {
  const node = nodeOf(menu.nodeId);
  if (node === undefined || node.kind !== "agent") {
    // A card that has no menu today: the pointer closes it on the next press.
    return null;
  }
  const open = (section: string) => () => {
    closeCanvasMenu();
    openAgentEditor(menu.nodeId, { section });
  };
  const rows: ReadonlyArray<Row> = [
    { key: "customize", label: "customize character", detail: "look, mood, name", ariaLabel: "Customize character", icon: <UserRoundPen size={14} />, onSelect: open("look") },
    { key: "rename", label: "rename", ariaLabel: "Rename agent", icon: <Pencil size={14} />, onSelect: open("name") },
    { key: "soul", label: "soul and instructions", detail: "who it is, how it works", ariaLabel: "Edit soul and instructions", icon: <ScrollText size={14} />, onSelect: open("soul") },
    { key: "profile", label: "save as profile", detail: "reuse anywhere", ariaLabel: "Save agent as a profile", icon: <BookmarkPlus size={14} />, onSelect: () => { closeCanvasMenu(); openSaveProfile(menu.nodeId); } },
  ];
  return (
    <MenuHost menu={menu} label="Agent actions" onClose={closeCanvasMenu}>
      {rows.map((row) => <MenuRow key={row.key} row={row} />)}
      <hr className="canvas-action-menu__rule" />
      <SeatOffboardMenuRows nodeIds={[menu.nodeId]} />
    </MenuHost>
  );
}

function TargetMenu({ menu }: { readonly menu: Extract<CanvasMenuState, { readonly kind: "target" }> }) {
  const target = nodeOf(menu.targetId);
  const title = target === undefined ? "that card" : titleOf(target);
  const count = menu.sourceIds.length;
  const label = count === 1 ? "Connect → target" : "Connect all → target";
  return (
    <MenuHost menu={menu} label="Connect" onClose={closeCanvasMenu}>
      <button
        aria-label={`${label}: ${count} source${count === 1 ? "" : "s"} to ${title}`}
        onClick={() => {
          connectAllToTarget(menu.sourceIds, menu.targetId);
          closeCanvasMenu();
        }}
      >
        <span className="canvas-action-menu__icon" aria-hidden><Link2 size={14} /></span>
        <span>
          <strong>{label}</strong>
          <small>{count} → {title}</small>
        </span>
      </button>
    </MenuHost>
  );
}

/** A region around the selection: pad 48, the selection already in view. */
const regionAround = (ids: ReadonlyArray<string>): void => {
  const name = state$.canvasName.peek();
  if (name === "") return;
  const nodes = canvasNodes().filter((node) => ids.includes(node.id));
  if (nodes.length === 0) return;
  const pad = 48;
  const minX = Math.min(...nodes.map((node) => node.x)) - pad;
  const minY = Math.min(...nodes.map((node) => node.y)) - pad;
  const maxX = Math.max(...nodes.map((node) => node.x + node.width)) + pad;
  const maxY = Math.max(...nodes.map((node) => node.y + node.height)) + pad;
  addNode(
    newRegion({ x: minX, y: minY, z: topZ(modelStore.canvasOf(name)) }, { width: maxX - minX, height: maxY - minY }),
    { edit: false, focus: false },
  );
};

function SelectionMenu({ menu }: { readonly menu: Extract<CanvasMenuState, { readonly kind: "selection" }> }) {
  const [composing, setComposing] = useState(false);
  const ids = menu.nodeIds;
  if (ids.length === 0) return null;
  const held = canvasNodes().filter((node) => ids.includes(node.id));
  const agents = seatIdsAmong(held);
  const count = ids.length;
  const nodes = `${count} node${count === 1 ? "" : "s"}`;
  const rows: ReadonlyArray<Row> = [
    ...(agents.length === 0 ? [] : [{
      key: "message",
      label: "message",
      detail: `${agents.length} agent${agents.length === 1 ? "" : "s"}`,
      ariaLabel: "Message the selected agents",
      icon: <MessageSquare size={14} />,
      onSelect: () => setComposing(true),
    }]),
    ...(agents.length < 2 ? [] : [{
      key: "connect",
      label: "connect",
      detail: `${agents.length} agents`,
      ariaLabel: "Connect the selected agents to each other",
      icon: <Link2 size={14} />,
      onSelect: () => { connectMesh(agents); closeCanvasMenu(); },
    }]),
    ...(agents.length === 0 ? [] : [{
      key: "open",
      label: "open",
      detail: `${agents.length} agent${agents.length === 1 ? "" : "s"}, grid`,
      ariaLabel: "Open the selected agents in a grid",
      icon: <LayoutGrid size={14} />,
      onSelect: () => { openTerminalGrid(agents); closeCanvasMenu(); },
    }]),
    { key: "region", label: "create region", detail: "from selection", ariaLabel: "Create region from selection", icon: <SquareDashed size={14} />, onSelect: () => { regionAround(ids); closeCanvasMenu(); } },
    ...(agents.length < 2 ? [] : [{
      key: "disconnect",
      label: "disconnect",
      detail: "between agents",
      ariaLabel: "Disconnect the selected agents",
      icon: <Unlink size={14} />,
      onSelect: () => { disconnectWithin(agents); closeCanvasMenu(); },
    }]),
    ...(agents.length === 1 ? [{
      key: "profile",
      label: "save as profile",
      detail: "1 agent, reusable",
      ariaLabel: "Save the agent as a profile",
      icon: <BookmarkPlus size={14} />,
      onSelect: () => { closeCanvasMenu(); openSaveProfile(agents[0]!); },
    }] : []),
    ...(agents.length === 0 ? [] : [{
      key: "squad",
      label: "save as squad",
      detail: `${agents.length} agent${agents.length === 1 ? "" : "s"}, reusable`,
      ariaLabel: "Save the selected agents as a squad",
      icon: <Users size={14} />,
      onSelect: () => { closeCanvasMenu(); openSaveSquad(agents); },
    }]),
    { key: "delete", label: `delete ${nodes}`, ariaLabel: `Delete ${count} nodes`, icon: <Trash2 size={14} />, onSelect: () => { deleteNodes(ids); closeCanvasMenu(); } },
  ];
  if (composing && agents.length > 0) {
    return (
      <MenuHost menu={menu} anchor={menu.anchor} label={`Message ${agents.length} agents`} onClose={closeCanvasMenu}>
        <div className="seat-message-menu">
          <SeatMessageForm nodeIds={agents} />
        </div>
      </MenuHost>
    );
  }
  return (
    <MenuHost menu={menu} anchor={menu.anchor} label={`Actions for ${nodes}`} onClose={closeCanvasMenu}>
      {rows.filter((row) => row.key !== "profile" && row.key !== "squad").map((row) => <MenuRow key={row.key} row={row} />)}
      {agents.length > 0 ? <hr className="canvas-action-menu__rule" /> : null}
      <SeatOffboardMenuRows nodeIds={agents} />
      {rows.filter((row) => row.key === "profile" || row.key === "squad").map((row) => <MenuRow key={row.key} row={row} />)}
      <hr className="canvas-action-menu__rule" />
      <SaveToGroupPicker
        count={count}
        onPick={(slot) => {
          saveSelectionToCommandGroup(ids, slot);
          closeCanvasMenu();
        }}
      />
    </MenuHost>
  );
}

/** The mounted canvas's menus. Renders nothing while none is open. */
export function CanvasMenus() {
  const menu = use$(() => canvasMenu$.get());
  if (menu === null) return null;
  switch (menu.kind) {
    case "pane":
      return <PaneMenu menu={menu} />;
    case "seat":
      return <SeatMenu menu={menu} />;
    case "target":
      return <TargetMenu menu={menu} />;
    case "selection":
      return <SelectionMenu menu={menu} />;
  }
}
