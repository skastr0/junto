import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Circle,
  Image as ImageIcon,
  MapPin,
  Maximize2,
  MousePointer2,
  Pencil,
  Square,
  Triangle,
  Type,
  Undo2,
} from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import { resolvePadInboundActors } from "@shared/board-actors";
import type { ContentRef } from "@shared/content";
import { contentObjectUrl } from "@shared/content-url";
import {
  applyPatches,
  type Pad,
  type PadElementId,
  type PadImage,
  type PadPatch,
  type PadPoint,
  type PadShape,
  type PadSide,
} from "@shared/pad";
import { state$ } from "../../lib/state";
import { PadPinThread } from "./PadPinThread";
import {
  anchorPoint,
  contentBounds,
  edgePoints,
  hitTest,
  identityCamera,
  sceneToView,
  strokePath,
  trianglePoints,
  type Camera,
} from "@shared/pad-geom";
import {
  padInkStroke,
  padShapeFill,
  padShapeStroke,
  padSvgPalette,
} from "@shared/pad-project";
import type { ThemeMode } from "@shared/theme";
import { themeMode$ } from "../../lib/theme-mode";
import { fileToClipboardImage } from "../../lib/clipboard-image";
import { putClipboardImage, putImagesFromDataTransfer } from "../../lib/image-content";
import { IconButton, Kbd } from "../ui";
import { PadGlyph } from "./PadGlyph";
import {
  CAMERA_ZOOM_MAX,
  CAMERA_ZOOM_MIN,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_INK_WIDTH,
  HANDLE_VIEW_PX,
  HIT_VIEW_PX,
  SIDE_VIEW_PX,
  appendInkPoint,
  applyLocalUndo,
  canDelete,
  canMove,
  canResize,
  canZ,
  clientToScene,
  clientToView,
  dataTransferHasImage,
  defaultInkColor,
  deletePatch,
  draftImageRect,
  draftInkFromPoints,
  draftPinFromDrag,
  finishInkStroke,
  draftShapeFromDrag,
  editableLayer,
  editorKeyAction,
  fitCamera,
  handleHit,
  imageById,
  inversePatches,
  isControlTarget,
  isShapeTool,
  isTypingTarget,
  moveImage,
  movePin,
  moveShape,
  nearestSide,
  newPadElementId,
  nextLayerZ,
  padIsEmpty,
  panBy,
  pinById,
  resizeImage,
  resizeShape,
  shapeById,
  sideHit,
  upsertEdgePatch,
  upsertImagePatch,
  upsertInkPatch,
  upsertPinPatch,
  upsertShapePatch,
  viewSlop,
  zOf,
  zPatch,
  zoomAt,
  type PadCommitOutcome,
  type PadShapeTool,
  type PadTool,
  type ResizeHandle,
} from "./pad-editor-model";

type Gesture =
  | { readonly kind: "idle" }
  | { readonly kind: "pan"; readonly last: PadPoint }
  | {
      readonly kind: "draw";
      readonly tool: PadShapeTool | "image";
      readonly start: PadPoint;
      readonly current: PadPoint;
      readonly id: PadElementId;
    }
  | {
      readonly kind: "pin";
      readonly start: PadPoint;
      readonly current: PadPoint;
      readonly id: PadElementId;
    }
  | {
      readonly kind: "ink";
      readonly id: PadElementId;
      readonly points: ReadonlyArray<PadPoint>;
    }
  | {
      readonly kind: "move";
      readonly id: PadElementId;
      readonly origin: PadPoint;
      readonly current: PadPoint;
      readonly start: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: "resize";
      readonly id: PadElementId;
      readonly handle: ResizeHandle;
      readonly current: PadPoint;
    }
  | {
      readonly kind: "edge";
      readonly from: PadElementId;
      readonly fromSide: PadSide;
      readonly current: PadPoint;
    };

type PendingImage = {
  readonly id: PadElementId;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly z: number;
};

type CommitTask = {
  readonly operatorPatches: ReadonlyArray<PadPatch>;
  /** Inverse frame for the operator patches, computed against `base`. */
  readonly inverse: ReadonlyArray<PadPatch>;
  readonly deletesPopulatedPin: boolean;
  /** Pad view the optimistic apply started from; used for rollback. */
  readonly base: Pad;
  /** Revision the frames were computed against. */
  readonly expectedRev: number;
  readonly retried: boolean;
};

/** Patch failure codes raised before the server mutates anything. */
const PRE_APPLY_CODES = new Set([
  "canvas_not_found",
  "node_not_found",
  "illegal_kind",
  "invalid",
  "illegal_transition",
  "wrong_home",
]);

const ShapeEl = ({
  shape,
  selected,
  theme,
}: {
  readonly shape: PadShape;
  readonly selected: boolean;
  readonly theme: ThemeMode;
}) => {
  const pal = padSvgPalette(theme);
  const fill = padShapeFill(shape, pal);
  const stroke = padShapeStroke(shape, pal);
  const common = {
    fill,
    stroke,
    strokeWidth: selected ? 1.75 : 1,
  };
  if (shape.type === "ellipse") {
    return (
      <ellipse
        cx={shape.x + shape.w / 2}
        cy={shape.y + shape.h / 2}
        rx={shape.w / 2}
        ry={shape.h / 2}
        {...common}
      />
    );
  }
  if (shape.type === "triangle") {
    const [a, b, c] = trianglePoints(shape);
    return (
      <polygon
        points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`}
        {...common}
      />
    );
  }
  return (
    <rect
      x={shape.x}
      y={shape.y}
      width={shape.w}
      height={shape.h}
      {...common}
    />
  );
};

const PadImageEl = ({
  image,
  selected,
}: {
  readonly image: PadImage;
  readonly selected: boolean;
}) => (
  <g data-testid="pad-image" data-image-id={image.id}>
    <rect
      x={image.x}
      y={image.y}
      width={image.w}
      height={image.h}
      fill="var(--color-overlay-1)"
      stroke={selected ? "var(--color-amber)" : "var(--color-stroke)"}
    />
    <image
      href={contentObjectUrl(image.ref)}
      x={image.x}
      y={image.y}
      width={image.w}
      height={image.h}
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: "none" }}
    />
  </g>
);

export function PadEditor({
  pad: remotePad,
  padNodeId,
  onCommit,
  onReadPad,
  onClose,
}: {
  readonly pad: Pad;
  readonly padNodeId: string;
  /** Queued pad write; resolves with the authoritative outcome. */
  readonly onCommit: (patches: ReadonlyArray<PadPatch>) => Promise<PadCommitOutcome>;
  /** Read (and mark pin threads read) through the host's acceptance path. */
  readonly onReadPad: (pinId?: string) => Promise<Pad | null>;
  readonly onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingImageRef = useRef<PendingImage | null>(null);
  const [camera, setCamera] = useState<Camera>(identityCamera);
  const [tool, setTool] = useState<PadTool>("select");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [gesture, setGestureState] = useState<Gesture>({ kind: "idle" });
  // Mirror gestures into a ref so stable callbacks (commit, undo, fit) can
  // check for in-flight drags without re-subscribing.
  const gestureRef = useRef<Gesture>({ kind: "idle" });
  const setGesture = useCallback((next: Gesture) => {
    gestureRef.current = next;
    setGestureState(next);
  }, []);
  const [spaceDown, setSpaceDown] = useState(false);
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const undoRef = useRef<PadPatch[][]>([]);
  const pendingInverseRef = useRef<PadPatch[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const [localPad, setLocalPad] = useState<Pad | undefined>();
  const remotePadRef = useRef(remotePad);
  // Serial commit queue: at most one `onCommit` in flight so revision
  // accounting sees exactly the patches it dispatched.
  const commitQueueRef = useRef<Promise<void>>(Promise.resolve());
  const commitBusyRef = useRef(false);
  const [commitBusy, setCommitBusy] = useState(false);
  // Authoritative pad revision the local undo history is based on.
  const expectedRevRef = useRef(remotePad.revision);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Transient status line; auto-clears so stale errors do not linger.
  const notice = useCallback((message: string) => {
    setHint(message);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(null), 4000);
  }, []);
  useEffect(
    () => () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    },
    [],
  );
  if (remotePadRef.current !== remotePad) {
    remotePadRef.current = remotePad;
    if (localPad !== undefined) setLocalPad(undefined);
    // Revision accounting: reads may lag, echo own acks, or reveal foreign
    // writes. Own acks are adopted in `dispatchCommit` (props never carry
    // them), so anything beyond the expected revision is foreign.
    const expected = expectedRevRef.current;
    if (remotePad.revision < expected) {
      // Stale echo of an older read; keep the current view.
    } else if (remotePad.revision === expected) {
      // Confirms the current base; keep the undo history and preview.
    } else {
      const hadHistory =
        undoRef.current.length > 0 || pendingInverseRef.current.length > 0;
      undoRef.current = [];
      pendingInverseRef.current = [];
      setUndoDepth(0);
      expectedRevRef.current = remotePad.revision;
      if (hadHistory) {
        notice("Pad changed elsewhere. Local undo history was cleared.");
      }
    }
  }
  const pad = localPad ?? remotePad;
  const padRef = useRef(pad);
  padRef.current = pad;
  const theme = use$(themeMode$);
  const inkColor = defaultInkColor(theme);
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName) || "";
  const mentionActors = resolvePadInboundActors(doc, padNodeId);
  const selectedPin = selectedId ? pinById(pad, selectedId) : undefined;

  const selected = selectedId
    ? shapeById(pad, selectedId) ?? imageById(pad, selectedId) ?? pinById(pad, selectedId)
    : undefined;
  const selectedLayer = selectedId ? editableLayer(pad, selectedId) : undefined;
  const empty = padIsEmpty(pad);

  const originOf = (): PadPoint => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: rect?.left ?? 0, y: rect?.top ?? 0 };
  };

  const sceneOf = (event: { clientX: number; clientY: number }): PadPoint =>
    clientToScene(camera, { x: event.clientX, y: event.clientY }, originOf());

  const fit = useCallback(() => {
    // Never yank the view out from under an active gesture.
    if (gestureRef.current.kind !== "idle") return;
    const el = svgRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    setCamera(fitCamera(contentBounds(padRef.current), { w: box.width, h: box.height }));
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    let fitted = false;
    const tryFit = () => {
      const box = svg.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return;
      if (!fitted) {
        fitted = true;
        fit();
      }
    };
    tryFit();
    const observer = new ResizeObserver(tryFit);
    observer.observe(svg);
    const onNativeWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Zooming mid-gesture corrupts in-flight drag geometry.
      if (gestureRef.current.kind !== "idle") return;
      const view = clientToView({ x: event.clientX, y: event.clientY }, originOf());
      const factor = event.deltaY < 0 ? 1.08 : 1 / 1.08;
      setCamera((current) => {
        const next = current.zoom * factor;
        if (next < CAMERA_ZOOM_MIN || next > CAMERA_ZOOM_MAX) return current;
        return zoomAt(current, view, factor);
      });
    };
    svg.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => {
      observer.disconnect();
      svg.removeEventListener("wheel", onNativeWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: wheel/resize bind to this SVG; originOf/fit read refs
  }, []);

  useEffect(() => {
    if (!selectedPin) return;
    // Marks the pin thread read and accepts a fresh pad through the host so
    // agent replies written while the pad is open become visible.
    void onReadPad(selectedPin.id);
  }, [onReadPad, selectedPin?.id]);

  const dispatchCommit = useCallback(
    async (task: CommitTask): Promise<boolean> => {
      const expected = expectedRevRef.current;
      const hadPending = pendingInverseRef.current.length > 0;
      const flushed = hadPending
        ? [...pendingInverseRef.current, ...task.operatorPatches]
        : task.operatorPatches;
      commitBusyRef.current = true;
      setCommitBusy(true);
      try {
        const outcome = await onCommit(flushed);
        if (outcome.ok) {
          // The batch is durable, so any frames computed before it are spent.
          pendingInverseRef.current = [];
          const nextExpected = expected + flushed.length;
          if (outcome.pad.revision === nextExpected) {
            // Contiguous own ack: every frame in the batch was applied on a
            // base that still exists, so undo history remains valid.
            expectedRevRef.current = nextExpected;
            if (
              !task.deletesPopulatedPin &&
              task.expectedRev === expected &&
              task.inverse.length > 0
            ) {
              undoRef.current = [...undoRef.current, [...task.inverse]];
              setUndoDepth(undoRef.current.length);
            }
          } else {
            // Revision gap: a foreign write interleaved and every frame we
            // hold was computed against a base that no longer exists.
            expectedRevRef.current = outcome.pad.revision;
            undoRef.current = [];
            setUndoDepth(0);
            notice("Pad changed elsewhere. Local undo history was cleared.");
          }
          setLocalPad(outcome.pad);
          return true;
        }
        if (hadPending && outcome.code === "illegal_transition" && !task.retried) {
          // The rejected batch carried pending inverse frames: an undo was
          // replayed against a stale base. Prove it with a fresh read, then
          // retry the operator's patches alone once.
          const fresh = await onReadPad();
          if (fresh !== null) {
            const inverseApplicable = Result.isSuccess(
              applyPatches(fresh, pendingInverseRef.current),
            );
            const operatorApplicable = Result.isSuccess(
              applyPatches(fresh, task.operatorPatches),
            );
            pendingInverseRef.current = [];
            undoRef.current = [];
            setUndoDepth(0);
            expectedRevRef.current = fresh.revision;
            setLocalPad(fresh);
            if (!inverseApplicable && operatorApplicable) {
              notice("Pad changed elsewhere. Undo history was cleared.");
              const retryInverse = inversePatches(fresh, task.operatorPatches);
              return dispatchCommit({
                operatorPatches: task.operatorPatches,
                inverse: Result.isSuccess(retryInverse)
                  ? [...retryInverse.success]
                  : [],
                deletesPopulatedPin: task.deletesPopulatedPin,
                base: fresh,
                expectedRev: fresh.revision,
                retried: true,
              });
            }
          }
          notice(outcome.message);
          return false;
        }
        if (outcome.code !== undefined && PRE_APPLY_CODES.has(outcome.code)) {
          // Rejected before anything applied: restore the pre-optimistic view.
          setLocalPad(task.base);
        }
        notice(outcome.message);
        return false;
      } finally {
        commitBusyRef.current = false;
        setCommitBusy(false);
      }
    },
    [notice, onCommit, onReadPad],
  );

  const commit = useCallback(
    (patches: ReadonlyArray<PadPatch>): Promise<boolean> => {
      if (patches.length === 0) return Promise.resolve(true);
      const base = padRef.current;
      const inverse = inversePatches(base, patches);
      const deletesPopulatedPin = patches.some(
        (patch) =>
          patch.op === "delete" &&
          (base.pins.find((pin) => pin.id === patch.id)?.posts.length ?? 0) > 0,
      );
      // Optimistic display; the authoritative pad replaces it at ack.
      const optimistic = applyPatches(base, patches);
      if (Result.isSuccess(optimistic)) setLocalPad(optimistic.success);
      const task: CommitTask = {
        operatorPatches: [...patches],
        inverse: Result.isSuccess(inverse) ? [...inverse.success] : [],
        deletesPopulatedPin,
        base,
        expectedRev: expectedRevRef.current,
        retried: false,
      };
      const run = commitQueueRef.current.then(() => dispatchCommit(task));
      commitQueueRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [dispatchCommit],
  );

  const undo = useCallback(() => {
    // Undo is a local view change; never interleave with a drag or an
    // in-flight commit.
    if (gestureRef.current.kind !== "idle" || commitBusyRef.current) return;
    const applied = applyLocalUndo(padRef.current, undoRef.current);
    if (!applied) return;
    if (Result.isFailure(applied)) {
      // The top frame no longer applies. Drop the poisoned frame instead of
      // wedging the whole stack.
      undoRef.current = undoRef.current.slice(0, -1);
      setUndoDepth(undoRef.current.length);
      notice("That change can no longer be undone.");
      return;
    }
    undoRef.current = applied.success.stack.map((frame) => [...frame]);
    pendingInverseRef.current = [
      ...pendingInverseRef.current,
      ...applied.success.frame,
    ];
    setUndoDepth(undoRef.current.length);
    setLocalPad(applied.success.pad);
    if (selectedId && !editableLayer(applied.success.pad, selectedId)) {
      setSelectedId(undefined);
    }
  }, [notice, selectedId]);

  const applyDelete = useCallback(async () => {
    if (!selectedId || !canDelete(selectedLayer)) return;
    const pin = pinById(padRef.current, selectedId);
    if (pin && pin.posts.length > 0) {
      notice("Pins with replies cannot be undone — delete removes the thread for good.");
    }
    await commit([deletePatch(selectedId as PadElementId)]);
    setSelectedId(undefined);
  }, [commit, notice, selectedId, selectedLayer]);

  const applyZ = useCallback(
    async (delta: 1 | -1) => {
      if (!selectedId || !canZ(selectedLayer)) return;
      const current = zOf(padRef.current, selectedId);
      if (current === undefined) return;
      await commit([zPatch(selectedId as PadElementId, current + delta)]);
    },
    [commit, selectedId, selectedLayer],
  );

  const applyNudge = useCallback(
    async (dx: number, dy: number) => {
      if (!selectedId || !canMove(selectedLayer)) return;
      const shape = shapeById(padRef.current, selectedId);
      if (shape) {
        await commit([upsertShapePatch(moveShape(shape, dx, dy))]);
        return;
      }
      const image = imageById(padRef.current, selectedId);
      if (image) {
        await commit([upsertImagePatch(moveImage(image, dx, dy))]);
        return;
      }
      const pin = pinById(padRef.current, selectedId);
      if (pin) await commit([upsertPinPatch(movePin(pin, dx, dy))]);
    },
    [commit, selectedId, selectedLayer],
  );

  const placeImage = useCallback(
    async (pending: PendingImage, ref: ContentRef): Promise<boolean> => {
      const ok = await commit([
        upsertImagePatch({
          id: pending.id,
          x: pending.x,
          y: pending.y,
          w: pending.w,
          h: pending.h,
          z: pending.z,
          ref,
        }),
      ]);
      if (ok) {
        setSelectedId(pending.id);
        setHint(null);
      }
      return ok;
    },
    [commit],
  );

  const ingestImageFile = useCallback(
    async (file: File, pending: PendingImage): Promise<boolean> => {
      const image = await fileToClipboardImage(file);
      if ("error" in image) {
        setHint(image.error);
        return false;
      }
      const put = await putClipboardImage(image, file.name.trim() || `image.${image.extension}`);
      if (!put.ok) {
        setHint(put.error);
        return false;
      }
      return placeImage(pending, put.ref);
    },
    [placeImage],
  );

  const placeRefAt = useCallback(
    async (ref: ContentRef, scene: PadPoint): Promise<boolean> => {
      const box = draftImageRect(scene, scene);
      return placeImage(
        {
          id: newPadElementId("image"),
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          z: nextLayerZ(padRef.current.images),
        },
        ref,
      );
    },
    [placeImage],
  );

  const ingestTransfer = useCallback(
    async (data: DataTransfer | null | undefined, scene: PadPoint): Promise<void> => {
      const result = await putImagesFromDataTransfer(data);
      if (result.kind === "error") {
        setHint(result.error);
        return;
      }
      if (result.kind !== "ok") return;
      const ref = result.refs[0];
      if (!ref) return;
      await placeRefAt(ref, scene);
    },
    [placeRefAt],
  );

  const requestImageFile = useCallback((pending: PendingImage) => {
    pendingImageRef.current = pending;
    const input = fileInputRef.current;
    if (!input) {
      setHint("Image picker is unavailable.");
      return;
    }
    input.value = "";
    input.click();
  }, []);

  const beginLabelEdit = useCallback((id?: string) => {
    const target = id ?? selectedId;
    const shape = target ? shapeById(padRef.current, target) : undefined;
    if (!shape || shape.type !== "label") return;
    setSelectedId(shape.id);
    setLabelDraft(shape.text ?? "");
    setEditingLabel(true);
  }, [selectedId]);

  const finishLabelEdit = useCallback(
    async (save: boolean) => {
      const shape = selectedId ? shapeById(padRef.current, selectedId) : undefined;
      setEditingLabel(false);
      if (!save || !shape || shape.type !== "label") return;
      const text = labelDraft.trim();
      const next = text.length > 0 ? { ...shape, text } : { ...shape, text: undefined };
      if (next.text === shape.text) return;
      await commit([upsertShapePatch(next)]);
    },
    [commit, labelDraft, selectedId],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " && !isTypingTarget(event.target) && !isControlTarget(event.target)) {
        if (!event.repeat) setSpaceDown(true);
        event.preventDefault();
        return;
      }
      const typing = isTypingTarget(event.target) || editingLabel;
      if (typing && event.key === "Escape") {
        // Child inputs own Escape (label input cancels itself; the pin thread
        // dismisses its mention menu and keeps the draft). Do not intercept.
        return;
      }
      const control = !typing && isControlTarget(event.target);
      const action = editorKeyAction(event, { typing, control });
      if (action) {
        event.preventDefault();
        event.stopPropagation();
      } else if (!typing) {
        // The pad surface owns the keyboard while open: a declined key must
        // not reach the factory canvas behind the modal — ReactFlow's
        // document-level deleteKeyCode deletes the selected node on
        // Backspace even when a pad control has focus. Only other listeners
        // are stopped; native behavior (focus move, button activation,
        // native Space/Enter) is preserved.
        event.stopPropagation();
      }
      switch (action?.type) {
        case "tool":
          setTool(action.tool);
          setEditingLabel(false);
          return;
        case "delete":
          void applyDelete();
          return;
        case "undo":
          undo();
          return;
        case "z":
          void applyZ(action.delta);
          return;
        case "nudge":
          void applyNudge(action.dx, action.dy);
          return;
        case "edit-label":
          beginLabelEdit();
          return;
        case "cancel":
          if (editingLabel) {
            void finishLabelEdit(false);
            return;
          }
          if (gesture.kind !== "idle") {
            setGesture({ kind: "idle" });
            return;
          }
          if (selectedId) {
            setSelectedId(undefined);
            return;
          }
          onClose();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [
    applyDelete,
    applyNudge,
    applyZ,
    beginLabelEdit,
    editingLabel,
    finishLabelEdit,
    gesture.kind,
    onClose,
    selectedId,
    undo,
  ]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isTypingTarget(event.target) || editingLabel) return;
      if (!dataTransferHasImage(event.clipboardData)) return;
      event.preventDefault();
      event.stopPropagation();
      const origin = originOf();
      const rect = svgRef.current?.getBoundingClientRect();
      const scene = clientToScene(
        camera,
        {
          x: origin.x + (rect?.width ?? DEFAULT_IMAGE_SIZE.w) / 2,
          y: origin.y + (rect?.height ?? DEFAULT_IMAGE_SIZE.h) / 2,
        },
        origin,
      );
      void ingestTransfer(event.clipboardData, scene);
    };
    window.addEventListener("paste", onPaste, true);
    return () => window.removeEventListener("paste", onPaste, true);
  }, [camera, editingLabel, ingestTransfer]);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 1 || (event.button === 0 && spaceDown)) {
      setGesture({ kind: "pan", last: { x: event.clientX, y: event.clientY } });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const scene = sceneOf(event);
    if (tool === "ink") {
      const id = newPadElementId("ink");
      setGesture({ kind: "ink", id, points: appendInkPoint([], scene) });
      setSelectedId(id);
      return;
    }
    if (tool === "pin") {
      const id = newPadElementId("pin");
      setGesture({ kind: "pin", id, start: scene, current: scene });
      setSelectedId(id);
      return;
    }
    if (tool !== "select") {
      const id = newPadElementId(tool);
      setGesture({ kind: "draw", tool, start: scene, current: scene, id });
      setSelectedId(id);
      return;
    }
    if (selected && canResize(selectedLayer) && "w" in selected) {
      const handle = handleHit(selected, scene, viewSlop(camera, HANDLE_VIEW_PX));
      if (handle) {
        setGesture({ kind: "resize", id: selected.id, handle, current: scene });
        return;
      }
    }
    const hit = hitTest(pad, scene, viewSlop(camera, HIT_VIEW_PX));
    if (!hit) {
      setSelectedId(undefined);
      return;
    }
    // Edge gestures start from any shape's side, selected or not.
    const hitShape = shapeById(pad, hit.id);
    if (hitShape) {
      const side = sideHit(hitShape, scene, viewSlop(camera, SIDE_VIEW_PX));
      if (side) {
        setGesture({ kind: "edge", from: hitShape.id, fromSide: side, current: scene });
        return;
      }
    }
    setSelectedId(hit.id);
    const layer = editableLayer(pad, hit.id);
    if (canMove(layer)) {
      const item = shapeById(pad, hit.id) ?? imageById(pad, hit.id) ?? pinById(pad, hit.id);
      if (item) {
        setGesture({
          kind: "move",
          id: hit.id,
          origin: scene,
          current: scene,
          start: { x: item.x, y: item.y },
        });
      }
    }
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (gesture.kind === "idle") return;
    if (gesture.kind === "pan") {
      setCamera((current) =>
        panBy(current, event.clientX - gesture.last.x, event.clientY - gesture.last.y),
      );
      setGesture({ kind: "pan", last: { x: event.clientX, y: event.clientY } });
      return;
    }
    const scene = sceneOf(event);
    if (gesture.kind === "draw" || gesture.kind === "pin") {
      setGesture({ ...gesture, current: scene });
      return;
    }
    if (gesture.kind === "ink") {
      setGesture({ ...gesture, points: appendInkPoint(gesture.points, scene) });
      return;
    }
    if (gesture.kind === "edge") {
      setGesture({ ...gesture, current: scene });
      return;
    }
    if (gesture.kind === "move" || gesture.kind === "resize") {
      setGesture({ ...gesture, current: scene });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    const scene = sceneOf(event);
    const current = gesture;
    setGesture({ kind: "idle" });
    if (current.kind === "draw") {
      if (current.tool === "image") {
        const box = draftImageRect(current.start, scene);
        requestImageFile({
          id: current.id,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          z: nextLayerZ(pad.images),
        });
        return;
      }
      const shape = draftShapeFromDrag(
        current.tool,
        current.start,
        scene,
        current.id,
        nextLayerZ(pad.shapes),
      );
      void commit([upsertShapePatch(shape)]).then((ok) => {
        if (ok && current.tool === "label") {
          setSelectedId(shape.id);
          setLabelDraft(shape.text ?? "");
          setEditingLabel(true);
        }
      });
      return;
    }
    if (current.kind === "pin") {
      void commit([upsertPinPatch(draftPinFromDrag(current.id, current.start, scene))]);
      return;
    }
    if (current.kind === "ink") {
      const points = finishInkStroke(current.points, scene);
      if (!points) {
        setSelectedId(undefined);
        return;
      }
      void commit([
        upsertInkPatch(
          draftInkFromPoints(
            current.id,
            points,
            nextLayerZ(pad.inks),
            inkColor,
            DEFAULT_INK_WIDTH,
          ),
        ),
      ]);
      return;
    }
    if (current.kind === "move") {
      const dx = scene.x - current.origin.x;
      const dy = scene.y - current.origin.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      const shape = shapeById(pad, current.id);
      if (shape) {
        void commit([upsertShapePatch(moveShape({ ...shape, x: current.start.x, y: current.start.y }, dx, dy))]);
        return;
      }
      const image = imageById(pad, current.id);
      if (image) {
        void commit([upsertImagePatch(moveImage({ ...image, x: current.start.x, y: current.start.y }, dx, dy))]);
        return;
      }
      const pin = pinById(pad, current.id);
      if (pin) {
        void commit([
          upsertPinPatch(movePin({ ...pin, x: current.start.x, y: current.start.y }, dx, dy)),
        ]);
      }
      return;
    }
    if (current.kind === "resize") {
      const shape = shapeById(pad, current.id);
      if (shape) {
        void commit([upsertShapePatch(resizeShape(shape, current.handle, scene))]);
        return;
      }
      const image = imageById(pad, current.id);
      if (image) void commit([upsertImagePatch(resizeImage(image, current.handle, scene))]);
      return;
    }
    if (current.kind === "edge") {
      const hit = hitTest(pad, scene, viewSlop(camera, HIT_VIEW_PX));
      if (!hit || hit.layer !== "shape" || hit.id === current.from) return;
      const to = shapeById(pad, hit.id);
      if (!to) return;
      const edge = {
        id: newPadElementId("edge"),
        from: current.from,
        to: to.id,
        fromSide: current.fromSide,
        toSide: nearestSide(to, scene),
      };
      void commit([upsertEdgePatch(edge)]);
      setSelectedId(edge.id);
    }
  };

  const previewPad = (): Pad => {
    if (gesture.kind === "draw" && isShapeTool(gesture.tool)) {
      const draft = draftShapeFromDrag(
        gesture.tool,
        gesture.start,
        gesture.current,
        gesture.id,
        nextLayerZ(pad.shapes),
      );
      return { ...pad, shapes: [...pad.shapes.filter((s) => s.id !== draft.id), draft] };
    }
    if (gesture.kind === "pin") {
      const draft = draftPinFromDrag(gesture.id, gesture.start, gesture.current);
      return {
        ...pad,
        pins: [...pad.pins.filter((pin) => pin.id !== draft.id), { ...draft, posts: [] }],
      };
    }
    if (gesture.kind === "ink") {
      const first = gesture.points[0];
      const second = gesture.points[1];
      if (!first || !second) return pad;
      const draft = draftInkFromPoints(
        gesture.id,
        [first, second, ...gesture.points.slice(2)],
        nextLayerZ(pad.inks),
        inkColor,
      );
      return { ...pad, inks: [...pad.inks.filter((ink) => ink.id !== draft.id), draft] };
    }
    if (gesture.kind === "move") {
      const dx = gesture.current.x - gesture.origin.x;
      const dy = gesture.current.y - gesture.origin.y;
      return {
        ...pad,
        shapes: pad.shapes.map((shape) =>
          shape.id === gesture.id
            ? moveShape({ ...shape, x: gesture.start.x, y: gesture.start.y }, dx, dy)
            : shape,
        ),
        images: pad.images.map((image) =>
          image.id === gesture.id
            ? moveImage({ ...image, x: gesture.start.x, y: gesture.start.y }, dx, dy)
            : image,
        ),
        pins: pad.pins.map((pin) =>
          pin.id === gesture.id
            ? { ...pin, ...movePin({ ...pin, x: gesture.start.x, y: gesture.start.y }, dx, dy) }
            : pin,
        ),
      };
    }
    if (gesture.kind === "resize") {
      return {
        ...pad,
        shapes: pad.shapes.map((shape) =>
          shape.id === gesture.id ? resizeShape(shape, gesture.handle, gesture.current) : shape,
        ),
        images: pad.images.map((image) =>
          image.id === gesture.id ? resizeImage(image, gesture.handle, gesture.current) : image,
        ),
      };
    }
    return pad;
  };

  const shown = previewPad();
  const shownSelected = selectedId
    ? shapeById(shown, selectedId) ?? imageById(shown, selectedId)
    : undefined;

  const labelView = (() => {
    if (!editingLabel || !shownSelected) return undefined;
    const view = sceneToView(camera, { x: shownSelected.x, y: shownSelected.y });
    return { left: view.x, top: view.y, width: shownSelected.w * camera.zoom };
  })();

  return (
    <div className="pad-surface__body">
      <div className="pad-toolbar" role="toolbar" aria-label="Pad tools">
        <div className="pad-toolbar__group">
          <ToolButton tool="select" current={tool} onSelect={setTool} label="Select (V)">
            <MousePointer2 size={13} />
          </ToolButton>
          <ToolButton tool="box" current={tool} onSelect={setTool} label="Box (R)">
            <Square size={13} />
          </ToolButton>
          <ToolButton tool="ellipse" current={tool} onSelect={setTool} label="Ellipse (O)">
            <Circle size={13} />
          </ToolButton>
          <ToolButton tool="triangle" current={tool} onSelect={setTool} label="Triangle (T)">
            <Triangle size={13} />
          </ToolButton>
          <ToolButton tool="label" current={tool} onSelect={setTool} label="Label (L)">
            <Type size={13} />
          </ToolButton>
          <ToolButton tool="pin" current={tool} onSelect={setTool} label="Pin (P)">
            <MapPin size={13} />
          </ToolButton>
          <ToolButton tool="image" current={tool} onSelect={setTool} label="Image (I)">
            <ImageIcon size={13} />
          </ToolButton>
          <ToolButton tool="ink" current={tool} onSelect={setTool} label="Ink (D)">
            <Pencil size={13} />
          </ToolButton>
        </div>
        <div className="pad-toolbar__sep" />
        <div className="pad-toolbar__group">
          <IconButton
            aria-label="Undo"
            title="Undo"
            size="sm"
            disabled={undoDepth === 0 || commitBusy}
            onClick={undo}
          >
            <Undo2 size={13} />
          </IconButton>
          <IconButton aria-label="Fit view" title="Fit view" size="sm" onClick={fit}>
            <Maximize2 size={13} />
          </IconButton>
        </div>
        <div className="pad-toolbar__hint">
          <Kbd>[</Kbd>
          <Kbd>]</Kbd>
          <span>z</span>
          <Kbd>⌫</Kbd>
          <span>delete</span>
          <Kbd>P</Kbd>
          <span>pin</span>
          <Kbd>I</Kbd>
          <span>image</span>
          <Kbd>D</Kbd>
          <span>ink</span>
        </div>
      </div>
      <div className="pad-workspace">
      <div
        className="pad-stage"
        onDragOver={(event) => {
          if (!dataTransferHasImage(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          if (!dataTransferHasImage(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          void ingestTransfer(event.dataTransfer, sceneOf(event));
        }}
      >
        <svg
          ref={svgRef}
          className="pad-svg"
          data-testid="pad-svg"
          data-tool={tool}
          data-panning={spaceDown || gesture.kind === "pan" ? "true" : "false"}
          tabIndex={0}
          role="application"
          aria-label="Pad canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setGesture({ kind: "idle" })}
          onDoubleClick={(event) => {
            const hit = hitTest(pad, sceneOf(event), viewSlop(camera, HIT_VIEW_PX));
            if (hit && shapeById(pad, hit.id)?.type === "label") {
              beginLabelEdit(hit.id);
            }
          }}
        >
          <rect width="100%" height="100%" fill="var(--color-ground)" />
          <g transform={`scale(${camera.zoom}) translate(${-camera.x} ${-camera.y})`}>
            {shown.images
              .slice()
              .sort((a, b) => a.z - b.z)
              .map((image) => (
                <PadImageEl
                  key={image.id}
                  image={image}
                  selected={image.id === selectedId}
                />
              ))}
            {shown.edges.map((edge) => {
              const points = edgePoints(shown, edge);
              if (!points) return null;
              return (
                <path
                  key={edge.id}
                  d={strokePath(points, 1.5)}
                  fill="none"
                  stroke={edge.id === selectedId ? "var(--color-amber)" : "var(--color-steel)"}
                  strokeWidth={edge.id === selectedId ? 2 : 1.5}
                />
              );
            })}
            {shown.shapes
              .slice()
              .sort((a, b) => a.z - b.z)
              .map((shape) => (
                <g key={shape.id}>
                  <ShapeEl
                    shape={shape}
                    selected={shape.id === selectedId}
                    theme={theme}
                  />
                  {shape.text ? (
                    <text
                      x={shape.x + 8}
                      y={shape.y + 16}
                      fill="var(--color-ink)"
                      fontSize={12}
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {shape.text}
                    </text>
                  ) : null}
                </g>
              ))}
            {shown.inks
              .slice()
              .sort((a, b) => a.z - b.z)
              .map((ink) => (
                <path
                  key={ink.id}
                  data-testid="pad-ink"
                  data-ink-id={ink.id}
                  d={strokePath(ink.points, ink.width)}
                  fill="none"
                  stroke={
                    ink.id === selectedId
                      ? "var(--color-amber)"
                      : padInkStroke(ink.color, padSvgPalette(theme))
                  }
                  strokeWidth={ink.id === selectedId ? ink.width + 1 : ink.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            {shown.pins.map((pin) => (
              <PinEl key={pin.id} pin={pin} selected={pin.id === selectedId} />
            ))}
            {gesture.kind === "draw" && gesture.tool === "image" ? (
              (() => {
                const box = draftImageRect(gesture.start, gesture.current);
                return (
                  <rect
                    x={box.x}
                    y={box.y}
                    width={box.w}
                    height={box.h}
                    fill="var(--color-overlay-1)"
                    stroke="var(--color-amber)"
                    strokeDasharray="4 3"
                  />
                );
              })()
            ) : null}
            {gesture.kind === "edge" ? (
              <line
                x1={(() => {
                  const from = shapeById(shown, gesture.from);
                  return from ? anchorPoint(from, gesture.fromSide).x : gesture.current.x;
                })()}
                y1={(() => {
                  const from = shapeById(shown, gesture.from);
                  return from ? anchorPoint(from, gesture.fromSide).y : gesture.current.y;
                })()}
                x2={gesture.current.x}
                y2={gesture.current.y}
                stroke="var(--color-amber)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ) : null}
            {shownSelected && canResize(selectedLayer) ? (
              <SelectionChrome item={shownSelected} zoom={camera.zoom} />
            ) : null}
          </g>
        </svg>
        {empty && gesture.kind === "idle" ? (
          <div className="pad-empty" data-testid="pad-empty">
            <PadGlyph className="pad-empty__mark" />
            <strong>Mark the page</strong>
            <span>
              Draw boxes, drop images, ink, and pin look-here crops. Wired agents
              read this page and patch structure. They never write the factory canvas.
            </span>
            <div className="pad-empty__keys">
              <span><Kbd>R</Kbd> box</span>
              <span><Kbd>O</Kbd> ellipse</span>
              <span><Kbd>T</Kbd> triangle</span>
              <span><Kbd>L</Kbd> label</span>
              <span><Kbd>P</Kbd> pin</span>
              <span><Kbd>I</Kbd> image</span>
              <span><Kbd>D</Kbd> ink</span>
            </div>
          </div>
        ) : null}
        {hint ? <div className="pad-hint">{hint}</div> : null}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,.png,.jpg,.jpeg,.gif,.webp,.bmp"
          className="pad-image-input"
          data-testid="pad-image-input"
          aria-label="Pad image file"
          onChange={(event) => {
            const file = event.target.files?.[0];
            const pending = pendingImageRef.current;
            event.target.value = "";
            if (!file || !pending) return;
            pendingImageRef.current = null;
            void ingestImageFile(file, pending);
          }}
        />
        {editingLabel && labelView ? (
          <input
            className="pad-label-edit"
            style={{ left: labelView.left, top: labelView.top, width: Math.max(72, labelView.width) }}
            value={labelDraft}
            autoFocus
            aria-label="Label text"
            onChange={(event) => setLabelDraft(event.target.value)}
            onBlur={() => void finishLabelEdit(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void finishLabelEdit(true);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                void finishLabelEdit(false);
              }
            }}
          />
        ) : null}
      </div>
      {selectedPin ? (
        <PadPinThread
          pin={selectedPin}
          nodes={doc.nodes}
          actors={mentionActors}
          onCommit={commit}
        />
      ) : null}
      </div>
    </div>
  );
}

function PinEl({
  pin,
  selected,
}: {
  readonly pin: { readonly id: string; readonly x: number; readonly y: number; readonly bounds?: { readonly w: number; readonly h: number } };
  readonly selected: boolean;
}) {
  const r = selected ? 6 : 5;
  return (
    <g data-testid="pad-pin" data-pin-id={pin.id}>
      {pin.bounds ? (
        <rect
          x={pin.x - pin.bounds.w / 2}
          y={pin.y - pin.bounds.h / 2}
          width={pin.bounds.w}
          height={pin.bounds.h}
          fill="none"
          stroke={selected ? "var(--color-amber)" : "var(--color-stroke)"}
          strokeDasharray="3 2"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <circle
        cx={pin.x}
        cy={pin.y}
        r={r}
        fill="var(--color-raise-2)"
        stroke="var(--color-amber)"
        strokeWidth={1.25}
      />
      <circle cx={pin.x} cy={pin.y} r={selected ? 2.2 : 1.8} fill="var(--color-amber)" />
    </g>
  );
}

function SelectionChrome({
  item,
  zoom,
}: {
  readonly item: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly zoom: number;
}) {
  const size = HANDLE_VIEW_PX / Math.max(zoom, 0.0001);
  const half = size / 2;
  const tick = Math.max(1.25 / Math.max(zoom, 0.0001), 0.35);
  const handles: Array<{ readonly k: ResizeHandle; readonly x: number; readonly y: number }> = [
    { k: "nw", x: item.x, y: item.y },
    { k: "ne", x: item.x + item.w, y: item.y },
    { k: "sw", x: item.x, y: item.y + item.h },
    { k: "se", x: item.x + item.w, y: item.y + item.h },
  ];
  const ticks: Array<{ readonly k: string; readonly x: number; readonly y: number }> = [
    { k: "t", x: item.x + item.w / 2, y: item.y },
    { k: "r", x: item.x + item.w, y: item.y + item.h / 2 },
    { k: "b", x: item.x + item.w / 2, y: item.y + item.h },
    { k: "l", x: item.x, y: item.y + item.h / 2 },
  ];
  return (
    <g data-testid="pad-selection" className="pad-chrome">
      <rect
        className="pad-chrome__bounds"
        x={item.x}
        y={item.y}
        width={item.w}
        height={item.h}
        fill="none"
        stroke="var(--color-amber)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {ticks.map((side) => (
        <circle
          key={side.k}
          className="pad-chrome__tick"
          cx={side.x}
          cy={side.y}
          r={tick}
          fill="var(--color-amber)"
        />
      ))}
      {handles.map((handle) => (
        <rect
          key={handle.k}
          className="pad-chrome__handle"
          data-testid="pad-handle"
          data-handle={handle.k}
          x={handle.x - half}
          y={handle.y - half}
          width={size}
          height={size}
          fill="var(--color-raise-2)"
          stroke="var(--color-amber)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
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

