import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useOnViewportChange, useReactFlow } from "@xyflow/react";
import type { MemberSeverity } from "@shared/region-rollup";
import { isBlockableNode } from "@shared/execution-graph";
import type { FlowEdge, FlowNode } from "../lib/convert";
import { nodeTitle, nodeTypeLabel } from "../lib/presentation";
import { signalMark, identityHue } from "../lib/signal-mark";
import { themeFor, withAlpha } from "../lib/theme";
import { themeMode$ } from "../lib/theme-mode";
import { state$ } from "../lib/state";
import "./CanvasMagnifier.css";

const LENS_SIZE = 312;
const LENS_RADIUS = LENS_SIZE / 2;
const CONTENT_RADIUS = LENS_RADIUS - 18;
const INSPECTION_SCALE = 0.78;
const MAX_VISIBLE_NODES = 64;

// Canvas-2D paint reads the resolved mode's runtime palette at paint time.
const paintTokens = (): Record<string, string> => themeFor(themeMode$.peek());

type Point = { x: number; y: number };

type VisibleNode = {
  readonly flow: FlowNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly distance: number;
  readonly severity: MemberSeverity;
};

const validSeverity = (value: string | undefined): value is MemberSeverity =>
  value === "blocked"
  || value === "attention"
  || value === "working"
  || value === "parked"
  || value === "idle";

const severityOf = (node: FlowNode): MemberSeverity => {
  const canvasNode = node.data.node;
  const seatStoppage =
    node.data.blocked ||
    (isBlockableNode(canvasNode) &&
      (canvasNode.ether?.flags?.includes("blocker") ?? false));
  if (seatStoppage) return "blocked";
  const live = state$.regionSeverityByNodeId.peek()[node.id];
  if (validSeverity(live)) return live;
  const flags = canvasNode.ether?.flags ?? [];
  if (flags.includes("attention")) return "attention";
  if (flags.includes("parked")) return "parked";
  return "idle";
};

const nodeBounds = (node: FlowNode) => {
  const width = node.measured?.width ?? node.width ?? node.data.node.width;
  const height = node.measured?.height ?? node.height ?? node.data.node.height;
  return {
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
};

const intersectsLens = (
  bounds: ReturnType<typeof nodeBounds>,
  center: Point,
  radius: number,
): boolean => {
  const nearestX = Math.max(bounds.x, Math.min(center.x, bounds.x + bounds.width));
  const nearestY = Math.max(bounds.y, Math.min(center.y, bounds.y + bounds.height));
  return Math.hypot(nearestX - center.x, nearestY - center.y) <= radius;
};

const visibleNodes = (nodes: ReadonlyArray<FlowNode>, center: Point): VisibleNode[] => {
  const worldRadius = CONTENT_RADIUS / INSPECTION_SCALE;
  return nodes
    .map((flow) => {
      const bounds = nodeBounds(flow);
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      return {
        flow,
        ...bounds,
        centerX,
        centerY,
        distance: Math.hypot(centerX - center.x, centerY - center.y),
        severity: severityOf(flow),
      };
    })
    .filter((node) => intersectsLens(node, center, worldRadius))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_VISIBLE_NODES)
    .sort((a, b) => {
      const aGroup = a.flow.data.node.type === "group" ? 0 : 1;
      const bGroup = b.flow.data.node.type === "group" ? 0 : 1;
      return aGroup - bGroup || b.distance - a.distance;
    });
};

const roundedRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  context.beginPath();
  context.roundRect(x, y, width, height, Math.min(radius, width / 2, height / 2));
};

const fitText = (
  context: CanvasRenderingContext2D,
  value: string,
  maxWidth: number,
): string => {
  if (context.measureText(value).width <= maxWidth) return value;
  let next = value;
  while (next.length > 1 && context.measureText(`${next}…`).width > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next}…`;
};

const drawField = (context: CanvasRenderingContext2D) => {
  const t = paintTokens();
  context.fillStyle = t.ground!;
  context.fillRect(0, 0, LENS_SIZE, LENS_SIZE);

  context.fillStyle = withAlpha(t.ink!, 0.07);
  for (let x = 10; x < LENS_SIZE; x += 26) {
    for (let y = 10; y < LENS_SIZE; y += 26) {
      context.beginPath();
      context.arc(x, y, 0.7, 0, Math.PI * 2);
      context.fill();
    }
  }

  const vignette = context.createRadialGradient(
    LENS_RADIUS,
    LENS_RADIUS,
    CONTENT_RADIUS * 0.45,
    LENS_RADIUS,
    LENS_RADIUS,
    CONTENT_RADIUS,
  );
  vignette.addColorStop(0, withAlpha(t.ground!, 0));
  vignette.addColorStop(1, withAlpha(t.ground!, 0.64));
  context.fillStyle = vignette;
  context.fillRect(0, 0, LENS_SIZE, LENS_SIZE);
};

const drawEdges = (
  context: CanvasRenderingContext2D,
  edges: ReadonlyArray<FlowEdge>,
  visible: ReadonlyArray<VisibleNode>,
  center: Point,
) => {
  const byId = new Map(visible.map((node) => [node.flow.id, node]));
  const t = paintTokens();
  context.lineCap = "round";
  for (const edge of edges) {
    const from = byId.get(edge.source);
    const to = byId.get(edge.target);
    if (!from || !to) continue;
    const fromX = LENS_RADIUS + (from.centerX - center.x) * INSPECTION_SCALE;
    const fromY = LENS_RADIUS + (from.centerY - center.y) * INSPECTION_SCALE;
    const toX = LENS_RADIUS + (to.centerX - center.x) * INSPECTION_SCALE;
    const toY = LENS_RADIUS + (to.centerY - center.y) * INSPECTION_SCALE;
    context.strokeStyle = edge.data?.phase === "blocks"
      ? withAlpha(t.crimson!, 0.72)
      : withAlpha(t.steel!, 0.34);
    context.lineWidth = edge.data?.phase === "blocks" ? 1.8 : 1;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  }
};

const drawNode = (
  context: CanvasRenderingContext2D,
  visible: VisibleNode,
  center: Point,
) => {
  const { flow, severity } = visible;
  const t = paintTokens();
  const source = flow.data.node;
  const x = LENS_RADIUS + (visible.x - center.x) * INSPECTION_SCALE;
  const y = LENS_RADIUS + (visible.y - center.y) * INSPECTION_SCALE;
  const width = visible.width * INSPECTION_SCALE;
  const height = visible.height * INSPECTION_SCALE;
  const isGroup = source.type === "group";
  const mark = signalMark(severity);
  const elevated = severity !== "idle";
  const accent = elevated ? mark.hue : identityHue(source);

  roundedRect(context, x, y, width, height, isGroup ? 4 : 7);
  context.fillStyle = isGroup ? withAlpha(t.steel!, 0.025) : t.raise!;
  context.fill();
  context.strokeStyle = elevated ? withAlpha(accent, 0.92) : t["stroke-hi"]!;
  context.lineWidth = elevated ? 1.6 : 1;
  context.stroke();

  if (isGroup) {
    context.fillStyle = withAlpha(identityHue(source), 0.75);
    context.font = "600 9px ui-monospace, SFMono-Regular, Menlo, monospace";
    context.fillText(fitText(context, nodeTitle(source), Math.max(width - 14, 8)), x + 7, y + 14);
    return;
  }

  context.fillStyle = accent;
  context.fillRect(x, y, Math.min(width, 3), height);

  context.fillStyle = t.ink!;
  context.font = "650 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillText(
    fitText(context, nodeTitle(source), Math.max(width - 34, 8)),
    x + 11,
    y + Math.min(21, height * 0.45),
  );

  if (height >= 38 && width >= 62) {
    context.fillStyle = elevated ? withAlpha(accent, 0.9) : t.dim!;
    context.font = "600 8px ui-monospace, SFMono-Regular, Menlo, monospace";
    const detail = elevated ? mark.label : nodeTypeLabel(source);
    context.fillText(
      fitText(context, detail.toUpperCase(), Math.max(width - 28, 8)),
      x + 11,
      y + height - 10,
    );
  }

  context.fillStyle = accent;
  context.beginPath();
  context.arc(x + width - 11, y + 13, elevated ? 3.2 : 2.4, 0, Math.PI * 2);
  context.fill();
};

const drawHud = (context: CanvasRenderingContext2D) => {
  const t = paintTokens();
  context.strokeStyle = withAlpha(t.amber!, 0.82);
  context.fillStyle = t.amber!;
  context.lineWidth = 1;

  context.beginPath();
  context.arc(LENS_RADIUS, LENS_RADIUS, CONTENT_RADIUS + 4, 0, Math.PI * 2);
  context.stroke();

  for (let index = 0; index < 8; index += 1) {
    const angle = (Math.PI * 2 * index) / 8;
    const inner = CONTENT_RADIUS + 8;
    const outer = CONTENT_RADIUS + (index % 2 === 0 ? 17 : 13);
    context.beginPath();
    context.moveTo(
      LENS_RADIUS + Math.cos(angle) * inner,
      LENS_RADIUS + Math.sin(angle) * inner,
    );
    context.lineTo(
      LENS_RADIUS + Math.cos(angle) * outer,
      LENS_RADIUS + Math.sin(angle) * outer,
    );
    context.stroke();
  }

  const bracketOffset = 91;
  const bracketLength = 19;
  for (const xDirection of [-1, 1]) {
    for (const yDirection of [-1, 1]) {
      const x = LENS_RADIUS + bracketOffset * xDirection;
      const y = LENS_RADIUS + bracketOffset * yDirection;
      context.beginPath();
      context.moveTo(x - bracketLength * xDirection, y);
      context.lineTo(x, y);
      context.lineTo(x, y - bracketLength * yDirection);
      context.stroke();
    }
  }

  context.globalAlpha = 0.52;
  context.beginPath();
  context.moveTo(LENS_RADIUS - 15, LENS_RADIUS);
  context.lineTo(LENS_RADIUS - 6, LENS_RADIUS);
  context.moveTo(LENS_RADIUS + 6, LENS_RADIUS);
  context.lineTo(LENS_RADIUS + 15, LENS_RADIUS);
  context.moveTo(LENS_RADIUS, LENS_RADIUS - 15);
  context.lineTo(LENS_RADIUS, LENS_RADIUS - 6);
  context.moveTo(LENS_RADIUS, LENS_RADIUS + 6);
  context.lineTo(LENS_RADIUS, LENS_RADIUS + 15);
  context.stroke();
  context.globalAlpha = 1;

  context.beginPath();
  context.arc(LENS_RADIUS, LENS_RADIUS, 2.2, 0, Math.PI * 2);
  context.fill();
};

const editableTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement
  && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));

const fieldTarget = (root: HTMLElement, target: EventTarget | null): boolean =>
  target instanceof Element
  && root.contains(target)
  && Boolean(target.closest(".react-flow__pane, .react-flow__node, .react-flow__edge"));

export function CanvasMagnifier() {
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const subjectRef = useRef<HTMLSpanElement>(null);
  const statusRef = useRef<HTMLSpanElement>(null);
  const targetRef = useRef<Point>({ x: 0, y: 0 });
  const currentRef = useRef<Point>({ x: 0, y: 0 });
  const pointerInsideRef = useRef(false);
  const altHeldRef = useRef(false);
  const activeRef = useRef(false);
  const frameRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setPortalTarget(anchorRef.current?.closest<HTMLElement>(".react-flow") ?? null);
  }, []);

  const renderLens = useCallback(() => {
    const shell = shellRef.current;
    const canvas = canvasRef.current;
    if (!shell || !canvas || !activeRef.current) return;
    const root = shell.closest<HTMLElement>(".react-flow");
    if (!root) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.round(LENS_SIZE * dpr);
    if (canvas.width !== width || canvas.height !== width) {
      canvas.width = width;
      canvas.height = width;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, LENS_SIZE, LENS_SIZE);
    context.save();
    context.beginPath();
    context.arc(LENS_RADIUS, LENS_RADIUS, CONTENT_RADIUS + 3, 0, Math.PI * 2);
    context.clip();
    drawField(context);

    const rootRect = root.getBoundingClientRect();
    const center = rf.screenToFlowPosition({
      x: rootRect.left + currentRef.current.x,
      y: rootRect.top + currentRef.current.y,
    });
    const visible = visibleNodes(rf.getNodes(), center);
    drawEdges(context, rf.getEdges(), visible, center);
    for (const node of visible) drawNode(context, node, center);
    context.restore();
    drawHud(context);

    const nearest = [...visible]
      .filter((node) => node.flow.data.node.type !== "group")
      .sort((a, b) => a.distance - b.distance)[0] ?? visible.at(-1);
    if (subjectRef.current) {
      subjectRef.current.textContent = nearest ? nodeTitle(nearest.flow.data.node) : "open field";
    }
    if (statusRef.current) {
      statusRef.current.textContent = nearest
        ? `${nodeTypeLabel(nearest.flow.data.node)} - ${signalMark(nearest.severity).label}`
        : "no node in range";
      statusRef.current.style.color = nearest && nearest.severity !== "idle"
        ? signalMark(nearest.severity).hue
        : "";
    }
  }, [rf]);

  const animate = useCallback(() => {
    frameRef.current = 0;
    if (!activeRef.current) return;
    const current = currentRef.current;
    const target = targetRef.current;
    const follow = reducedMotionRef.current ? 1 : 0.34;
    current.x += (target.x - current.x) * follow;
    current.y += (target.y - current.y) * follow;
    const shell = shellRef.current;
    if (shell) {
      shell.style.setProperty("--magnifier-x", `${current.x}px`);
      shell.style.setProperty("--magnifier-y", `${current.y}px`);
      const root = shell.closest<HTMLElement>(".react-flow");
      shell.dataset.readoutSide = root && current.x > root.clientWidth - 280 ? "left" : "right";
    }
    renderLens();
    if (Math.abs(target.x - current.x) > 0.2 || Math.abs(target.y - current.y) > 0.2) {
      frameRef.current = requestAnimationFrame(animate);
    }
  }, [renderLens]);

  const requestRender = useCallback(() => {
    if (frameRef.current || !activeRef.current) return;
    frameRef.current = requestAnimationFrame(animate);
  }, [animate]);

  // Repaint the lens when the theme mode flips while it is visible.
  useEffect(
    () => themeMode$.onChange(() => requestRender()),
    [requestRender],
  );

  const setActive = useCallback((active: boolean) => {
    if (activeRef.current === active) return;
    activeRef.current = active;
    const shell = shellRef.current;
    if (!shell) return;
    shell.dataset.active = String(active);
    if (active) {
      currentRef.current = { ...targetRef.current };
      requestRender();
    } else if (frameRef.current) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    }
  }, [requestRender]);

  useOnViewportChange({
    onChange: requestRender,
    onEnd: requestRender,
  });

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => {
      reducedMotionRef.current = motion.matches;
    };
    syncMotion();
    motion.addEventListener("change", syncMotion);

    const onPointerMove = (event: PointerEvent) => {
      const shell = shellRef.current;
      const root = shell?.closest<HTMLElement>(".react-flow");
      if (!shell || !root) return;
      const inside = fieldTarget(root, event.target);
      pointerInsideRef.current = inside;
      if (!inside || editableTarget(event.target)) {
        setActive(false);
        return;
      }
      const rect = root.getBoundingClientRect();
      targetRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      setActive(altHeldRef.current);
      requestRender();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Alt" || event.repeat || editableTarget(document.activeElement)) return;
      altHeldRef.current = true;
      if (!pointerInsideRef.current) return;
      event.preventDefault();
      setActive(true);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Alt") return;
      altHeldRef.current = false;
      setActive(false);
    };

    const deactivate = () => {
      altHeldRef.current = false;
      pointerInsideRef.current = false;
      setActive(false);
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", deactivate);
    document.addEventListener("visibilitychange", deactivate);
    return () => {
      motion.removeEventListener("change", syncMotion);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", deactivate);
      document.removeEventListener("visibilitychange", deactivate);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [portalTarget, requestRender, setActive]);

  const lens = (
    <div
      ref={shellRef}
      className="canvas-magnifier"
      data-active="false"
      data-readout-side="right"
      data-testid="canvas-magnifier"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="canvas-magnifier__canvas" />
      <div className="canvas-magnifier__readout">
        <span className="canvas-magnifier__mode">field scan - 0.8×</span>
        <span ref={subjectRef} className="canvas-magnifier__subject">open field</span>
        <span ref={statusRef} className="canvas-magnifier__status">no node in range</span>
      </div>
    </div>
  );

  return (
    <>
      <span ref={anchorRef} hidden />
      {portalTarget ? createPortal(lens, portalTarget) : null}
    </>
  );
}
