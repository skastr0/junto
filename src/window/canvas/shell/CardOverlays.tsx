/**
 * The DOM over the GPU canvas (docs/canvas-gpu-architecture.md section 16):
 * the floating selection toolbar, and the inline editors for a note, a label
 * and a region's title.
 *
 * The canvas draws cards itself, so nothing here lives in a card's React
 * tree. Every element is positioned from the shell's mirror and written
 * straight to its styles on a camera or rectangle change: a pan, a drag or a
 * seat report commits no render. The editors scale with the camera and take
 * the card's own text out of the paint while they stand in for it.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Crosshair, Pencil, Trash2 } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { Node as ModelNode } from "@shared/model/kinds";
import { IconButton, ToolbarPill } from "../../components/ui";
import { claimFocus } from "../../lib/focus-ownership";
import { deleteNode, editText, renameGroup } from "../../lib/mutations";
import { state$, toggleConnectionFocus } from "../../lib/state";
import { useNode, useNodeValue } from "../../lib/use-model";
import type { GpuCanvasApi } from "./gpu-canvas-api";
import type { SurfaceMirror } from "./surface-mirror";

/** The selection the rest of the window holds, in `state$`'s two shapes.
 *  `.get()` (not `.peek()`): this runs inside `use$`, which tracks reads. */
const selectionNow = (): ReadonlyArray<string> => {
  const many = state$.selectedNodeIds.get();
  const one = state$.selectedNodeId.get();
  return many.length > 0 ? many : one === "" ? [] : [one];
};

const overlayStack = 40;

const textOf = (node: ModelNode): string => {
  switch (node.kind) {
    case "note":
    case "label":
      return node.text;
    case "region":
      return node.label ?? "";
    default:
      return "";
  }
};

/** Kinds with an editor here; every other kind keeps its RTS actions. */
const editableKind = (kind: string | undefined): boolean =>
  kind === "note" || kind === "label" || kind === "region";

/**
 * The floating toolbar above the one selected card: edit where this shell has
 * an editor, the connection focus, and delete. A multi-selection has no
 * floating pill (the RTS bar owns bulk actions), the same rule the DOM card
 * toolbar followed.
 */
function SelectionToolbar({
  id,
  mirror,
}: {
  readonly id: string;
  readonly mirror: SurfaceMirror;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasName = use$(state$.canvasName);
  // Only the kind: a drag or a seat report rewrites other fields of the row,
  // and the toolbar must not commit React for them.
  const kind = useNodeValue(canvasName, id, (node) => node?.kind);
  const canEdit = editableKind(kind);
  const focused = use$(state$.connectionFocusNodeId) === id;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const place = (): void => {
      const rect = mirror.screenRectOf(id);
      if (rect === undefined) {
        host.style.visibility = "hidden";
        return;
      }
      host.style.visibility = "visible";
      host.style.transform = `translate3d(${rect.x + rect.width / 2}px, ${rect.y - 8}px, 0) translate(-50%, -100%)`;
    };
    place();
    const offCamera = mirror.onCamera(place);
    const offRects = mirror.onRects(place);
    return () => {
      offCamera();
      offRects();
    };
  }, [id, mirror]);

  return (
    <div
      ref={hostRef}
      data-canvas-overlay="selection-toolbar"
      style={{ position: "fixed", left: 0, top: 0, zIndex: overlayStack, willChange: "transform" }}
    >
      <ToolbarPill>
        {canEdit ? (
          <IconButton
            aria-label="Edit card"
            title="Edit"
            onClick={() => state$.editNodeId.set(id)}
          >
            <Pencil size={14} />
          </IconButton>
        ) : null}
        <IconButton
          aria-label={focused ? "Clear node focus" : "Focus node"}
          aria-pressed={focused}
          data-testid="node-toolbar-focus"
          data-focused={focused ? "true" : "false"}
          onClick={() => toggleConnectionFocus(id)}
        >
          <Crosshair size={14} />
        </IconButton>
        <IconButton
          tone="danger"
          aria-label="Delete node"
          title="Delete node"
          onClick={() => deleteNode(id)}
        >
          <Trash2 size={14} />
        </IconButton>
      </ToolbarPill>
    </div>
  );
}

/**
 * Inline editor standing in for the card's own text. The note and the label
 * hold text whole (`editText`); a region's title is its label (`renameGroup`).
 * The card is drawn at its board size and the host scales it by the camera,
 * so the caret and the type match what the canvas draws underneath.
 */
function InlineEditor({
  id,
  mirror,
  api,
}: {
  readonly id: string;
  readonly mirror: SurfaceMirror;
  readonly api: GpuCanvasApi;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);
  const canvasName = use$(state$.canvasName);
  const node = useNode(canvasName, id);
  const [draft, setDraft] = useState(() => (node === undefined ? "" : textOf(node)));
  const kind = node?.kind;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const place = (): void => {
      const rect = mirror.screenRectOf(id);
      if (rect === undefined) {
        host.style.visibility = "hidden";
        return;
      }
      const zoom = mirror.camera().zoom;
      host.style.visibility = "visible";
      host.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0) scale(${zoom})`;
      host.style.width = `${rect.width / zoom}px`;
      host.style.height = `${rect.height / zoom}px`;
    };
    place();
    const offCamera = mirror.onCamera(place);
    const offRects = mirror.onRects(place);
    return () => {
      offCamera();
      offRects();
    };
  }, [id, mirror]);

  // The card's own text comes out of the paint while this stands in for it.
  useEffect(() => {
    api.applyScene([{ kind: "editing", id }]);
    return () => api.applyScene([{ kind: "editing", id: null }]);
  }, [api, id]);

  useEffect(() => {
    if (node !== undefined) setDraft(textOf(node));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    claimFocus(fieldRef.current, "open", { select: true });
  }, [id]);

  const close = (): void => state$.editNodeId.set("");

  const commit = (): void => {
    if (node !== undefined && draft !== textOf(node)) {
      if (node.kind === "region") renameGroup(id, draft);
      else editText(id, draft);
    }
    close();
  };

  const discard = (): void => {
    setDraft(node === undefined ? "" : textOf(node));
    close();
  };

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      discard();
      return;
    }
    const send = (event.metaKey || event.ctrlKey) && event.key === "Enter";
    if (send || (kind !== "note" && event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      commit();
    }
  };

  if (node === undefined || !editableKind(node.kind)) return null;

  if (node.kind === "note") {
    return (
      <div
        ref={hostRef}
        data-canvas-overlay="note-editor"
        style={{ position: "fixed", left: 0, top: 0, zIndex: overlayStack, transformOrigin: "top left", willChange: "transform" }}
      >
        <textarea
          ref={fieldRef as RefObject<HTMLTextAreaElement>}
          data-focus-owner="canvas-draft"
          aria-label="Edit note"
          className="note-edit-inline nodrag nowheel h-full w-full resize-none bg-transparent font-mono outline-none"
          style={{ color: "var(--color-ink)", padding: "10px 12px" }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </div>
    );
  }

  if (node.kind === "label") {
    return (
      <div
        ref={hostRef}
        data-canvas-overlay="label-editor"
        style={{ position: "fixed", left: 0, top: 0, zIndex: overlayStack, transformOrigin: "top left", willChange: "transform" }}
      >
        <input
          ref={fieldRef as RefObject<HTMLInputElement>}
          data-focus-owner="canvas-draft"
          aria-label="Edit label"
          className="label-edit-inline h-full w-full border-0 bg-transparent p-0 outline-none"
          style={{ color: "var(--color-ink)" }}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      </div>
    );
  }

  // A region's title bar, in board units: the strip the canvas draws at the
  // top of the frame (paint/region.ts REGION.titlebar).
  return (
    <div
      ref={hostRef}
      data-canvas-overlay="region-title-editor"
      style={{ position: "fixed", left: 0, top: 0, zIndex: overlayStack, transformOrigin: "top left", willChange: "transform" }}
    >
      <input
        ref={fieldRef as RefObject<HTMLInputElement>}
        data-focus-owner="canvas-draft"
        aria-label="Region name"
        className="h-6 w-full rounded-t-[13px] border-0 bg-transparent px-2 font-mono text-xs font-semibold outline-none"
        style={{ color: "var(--color-ink)" }}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/**
 * Everything the GPU canvas mounts over the cards. One selection reads as a
 * floating pill; one editor stands in for the card's text; nothing else.
 */
export function CardOverlays({
  mirror,
  api,
}: {
  readonly mirror: SurfaceMirror;
  readonly api: GpuCanvasApi;
}) {
  const selection = use$(() => selectionNow());
  const editId = use$(state$.editNodeId);
  const sole = selection.length === 1 ? selection[0] : undefined;
  return (
    <>
      {sole !== undefined && editId === "" ? <SelectionToolbar id={sole} mirror={mirror} /> : null}
      {editId !== "" ? <InlineEditor id={editId} mirror={mirror} api={api} /> : null}
    </>
  );
}
