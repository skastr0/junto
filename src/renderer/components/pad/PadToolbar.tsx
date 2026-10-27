import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  Ban,
  Circle,
  Cylinder,
  Database,
  Diamond,
  Image as ImageIcon,
  Maximize2,
  MessageSquare,
  MousePointer2,
  Pencil,
  Spline,
  Split,
  Square,
  SquareActivity,
  StickyNote,
  TextCursorInput,
  Triangle,
  Type,
  Undo2,
  Workflow,
} from "lucide-react";
import type { PadEdge, PadShape, PadShapeStatus } from "@shared/pad";
import { IconButton, Kbd } from "../ui";
import { claimFocus } from "../../lib/focus-ownership";
import type { PadTool } from "./pad-editor-model";
import {
  PAD_FILL_SWATCHES,
  PAD_STATUSES,
  PAD_STROKE_SWATCHES,
  stencilById,
  type PadShapeStyle,
  type PadStencilId,
} from "./pad-stencils";
import "./pad-toolbar.css";

/** What the selection strip edits: a shape's paint, status and text, or an edge's label. */
export type PadToolbarSelection =
  | { readonly layer: "shape"; readonly shape: PadShape }
  | { readonly layer: "edge"; readonly edge: PadEdge };

type ToolDef = {
  readonly tool: PadTool;
  readonly label: string;
  readonly icon: ReactNode;
};

const TOOLS: ReadonlyArray<ToolDef> = [
  { tool: "select", label: "Select (V)", icon: <MousePointer2 size={13} /> },
  { tool: "box", label: "Box (R)", icon: <Square size={13} /> },
  { tool: "ellipse", label: "Ellipse (O)", icon: <Circle size={13} /> },
  { tool: "triangle", label: "Triangle (T)", icon: <Triangle size={13} /> },
  { tool: "diamond", label: "Diamond", icon: <Diamond size={13} /> },
  { tool: "cylinder", label: "Cylinder", icon: <Cylinder size={13} /> },
  { tool: "label", label: "Label (L)", icon: <Type size={13} /> },
  { tool: "connect", label: "Connect (A)", icon: <Spline size={13} /> },
  { tool: "area", label: "Comment on an area (P)", icon: <MessageSquare size={13} /> },
  { tool: "image", label: "Image (I)", icon: <ImageIcon size={13} /> },
  { tool: "ink", label: "Ink (D)", icon: <Pencil size={13} /> },
];

const STENCIL_ICONS: Readonly<Record<PadStencilId, ReactNode>> = {
  sticky: <StickyNote size={13} />,
  process: <SquareActivity size={13} />,
  decision: <Split size={13} />,
  store: <Database size={13} />,
  flow: <Workflow size={13} />,
};

const STENCIL_ORDER: ReadonlyArray<PadStencilId> = ["sticky", "process", "decision", "store", "flow"];

const STATUS_TONE: Readonly<Record<PadShapeStatus, string>> = {
  none: "var(--color-steel)",
  active: "var(--color-cyan)",
  done: "var(--color-green)",
  blocked: "var(--color-crimson)",
};

const ROVING_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

const rovingStops = (bar: HTMLElement): HTMLButtonElement[] =>
  Array.from(bar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));

const makeCurrent = (bar: HTMLElement, current: HTMLButtonElement | undefined): void => {
  // Every button, disabled ones too, so one that comes back enabled is not a second stop.
  for (const stop of bar.querySelectorAll<HTMLButtonElement>("button")) stop.tabIndex = stop === current ? 0 : -1;
};

/**
 * One Tab stop per toolbar, the toolbar pattern: the stop is the last
 * focused button, else the pressed one, else the first. A disabled or
 * removed stop hands over on the next render.
 */
function useRovingToolbar(ref: RefObject<HTMLDivElement | null>): void {
  const lastRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const stops = rovingStops(bar);
    const last = lastRef.current;
    const current = (last && stops.includes(last) ? last : undefined)
      ?? stops.find((stop) => stop.getAttribute("aria-pressed") === "true")
      ?? stops[0];
    makeCurrent(bar, current);
  });
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const onFocus = (event: FocusEvent) => {
      const button = event.target instanceof HTMLElement ? event.target.closest("button") : null;
      if (!button || !bar.contains(button)) return;
      lastRef.current = button;
      makeCurrent(bar, button);
    };
    bar.addEventListener("focusin", onFocus);
    return () => bar.removeEventListener("focusin", onFocus);
    // Every render: the strip swaps its root between an edge and a shape.
  });
}

/**
 * Left and Right (and Home, End) move between a pad toolbar's buttons,
 * wrapping at the ends. The editor's key handler calls this first, since it
 * stops every key at the window. True when the key was taken.
 */
export const padToolbarKey = (event: KeyboardEvent): boolean => {
  if (!ROVING_KEYS.has(event.key) || event.altKey || event.metaKey || event.ctrlKey) return false;
  const button = event.target instanceof HTMLElement ? event.target.closest("button") : null;
  const bar = button?.closest<HTMLElement>(".pad-toolbar, .pad-selbar");
  if (!button || !bar) return false;
  const stops = rovingStops(bar);
  const index = stops.indexOf(button);
  if (index === -1) return false;
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? stops.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : -1) + stops.length) % stops.length;
  // A refused claim leaves the key to pass on.
  return claimFocus(stops[next], "gesture", { event });
};

export function PadToolbar({
  tool,
  onTool,
  areaTool,
  canUndo,
  onUndo,
  onFit,
  onStencil,
}: {
  readonly tool: PadTool;
  readonly onTool: (tool: PadTool) => void;
  /** The host takes area comments; without it there is no P tool. */
  readonly areaTool: boolean;
  readonly canUndo: boolean;
  readonly onUndo: () => void;
  readonly onFit: () => void;
  /** Drop the stencil at the view's center as one write. */
  readonly onStencil: (id: PadStencilId) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  useRovingToolbar(barRef);
  return (
    <div ref={barRef} className="pad-toolbar" role="toolbar" aria-label="Pad tools">
      <div className="pad-toolbar__group">
        {TOOLS.filter((def) => def.tool !== "area" || areaTool).map((def) => (
          <ToolButton key={def.tool} tool={def.tool} current={tool} onSelect={onTool} label={def.label}>
            {def.icon}
          </ToolButton>
        ))}
      </div>
      <div className="pad-toolbar__sep" />
      <div className="pad-toolbar__group" role="group" aria-label="Stencils">
        {STENCIL_ORDER.map((id) => {
          const name = stencilById(id).name;
          return (
            <button
              key={id}
              type="button"
              className="pad-tool"
              data-testid={`pad-stencil-${id}`}
              aria-label={`Add ${name.toLowerCase()}`}
              title={`Add ${name.toLowerCase()}`}
              onClick={() => onStencil(id)}
            >
              {STENCIL_ICONS[id]}
            </button>
          );
        })}
      </div>
      <div className="pad-toolbar__sep" />
      <div className="pad-toolbar__group">
        <IconButton aria-label="Undo" title="Undo" size="sm" disabled={!canUndo} onClick={onUndo}>
          <Undo2 size={13} />
        </IconButton>
        <IconButton aria-label="Fit view" title="Fit view" size="sm" onClick={onFit}>
          <Maximize2 size={13} />
        </IconButton>
      </div>
      <div className="pad-toolbar__hint">
        <Kbd>[</Kbd>
        <Kbd>]</Kbd>
        <span>z</span>
        <Kbd>⌫</Kbd>
        <span>delete</span>
        {areaTool ? (
          <>
            <Kbd>P</Kbd>
            <span>comment</span>
          </>
        ) : null}
        <Kbd>I</Kbd>
        <span>image</span>
        <Kbd>D</Kbd>
        <span>ink</span>
      </div>
    </div>
  );
}

/**
 * The selected shape's status, fill, stroke and text, or the selected
 * edge's label: the fields only agents could write before.
 */
export function PadSelectionBar({
  selection,
  onRestyle,
  onEditText,
}: {
  readonly selection: PadToolbarSelection;
  readonly onRestyle: (style: PadShapeStyle) => void;
  readonly onEditText: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  useRovingToolbar(barRef);
  if (selection.layer === "edge") {
    return (
      <div ref={barRef} className="pad-selbar" role="toolbar" aria-label="Edge" data-testid="pad-selbar">
        <span className="pad-selbar__kind">Edge</span>
        <TextButton label={selection.edge.label ? "Edit the edge label" : "Add an edge label"} onClick={onEditText} />
      </div>
    );
  }
  const { shape } = selection;
  const status = shape.status ?? "none";
  return (
    <div ref={barRef} className="pad-selbar" role="toolbar" aria-label="Shape style" data-testid="pad-selbar">
      <span className="pad-selbar__kind">{shape.type}</span>
      <div className="pad-selbar__group" role="group" aria-label="Status">
        <span className="pad-selbar__label" aria-hidden="true">Status</span>
        {PAD_STATUSES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            className="pad-swatch"
            data-testid={`pad-status-${entry.value}`}
            aria-label={entry.name}
            title={entry.name}
            aria-pressed={status === entry.value}
            onClick={() => onRestyle({ status: entry.value })}
          >
            <span
              className="pad-swatch__dot"
              data-hollow={entry.value === "none" ? "true" : undefined}
              style={{ ["--swatch" as string]: STATUS_TONE[entry.value] }}
            />
          </button>
        ))}
      </div>
      <div className="pad-selbar__sep" />
      <SwatchGroup
        name="Fill"
        field="fill"
        swatches={PAD_FILL_SWATCHES}
        current={shape.fill}
        onRestyle={onRestyle}
      />
      <div className="pad-selbar__sep" />
      <SwatchGroup
        name="Stroke"
        field="stroke"
        swatches={PAD_STROKE_SWATCHES}
        current={shape.stroke}
        onRestyle={onRestyle}
      />
      <div className="pad-selbar__sep" />
      <TextButton label={shape.text ? "Edit the text (Enter)" : "Add text (Enter)"} onClick={onEditText} />
    </div>
  );
}

function SwatchGroup({
  name,
  field,
  swatches,
  current,
  onRestyle,
}: {
  readonly name: string;
  readonly field: "fill" | "stroke";
  readonly swatches: ReadonlyArray<{ readonly id: string; readonly name: string; readonly value: string }>;
  readonly current: string | undefined;
  readonly onRestyle: (style: PadShapeStyle) => void;
}) {
  return (
    <div className="pad-selbar__group" role="group" aria-label={name}>
      <span className="pad-selbar__label" aria-hidden="true">{name}</span>
      {swatches.map((swatch) => (
        <button
          key={swatch.id}
          type="button"
          className="pad-swatch"
          data-testid={`pad-${field}-${swatch.id}`}
          aria-label={`${name} ${swatch.name.toLowerCase()}`}
          title={`${name} ${swatch.name.toLowerCase()}`}
          aria-pressed={current === swatch.value}
          onClick={() => onRestyle({ [field]: swatch.value })}
        >
          <span
            className="pad-swatch__dot"
            data-field={field}
            // The fill's edge drops the alpha so the five read apart.
            style={{ ["--swatch" as string]: swatch.value, ["--swatch-edge" as string]: swatch.value.slice(0, 7) }}
          />
        </button>
      ))}
      <button
        type="button"
        className="pad-swatch"
        data-testid={`pad-${field}-clear`}
        aria-label={`${name} from the theme`}
        title={`${name} from the theme`}
        aria-pressed={current === undefined}
        onClick={() => onRestyle({ [field]: undefined })}
      >
        <Ban size={12} />
      </button>
    </div>
  );
}

function TextButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button
      type="button"
      className="pad-tool pad-selbar__text"
      data-testid="pad-edit-text"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <TextCursorInput size={13} />
      <span>Text</span>
    </button>
  );
}

function ToolButton({
  tool,
  current,
  onSelect,
  label,
  children,
}: {
  readonly tool: PadTool;
  readonly current: PadTool;
  readonly onSelect: (tool: PadTool) => void;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="pad-tool"
      data-testid={`pad-tool-${tool}`}
      aria-label={label}
      title={label}
      aria-pressed={current === tool}
      onClick={() => onSelect(tool)}
    >
      {children}
    </button>
  );
}
