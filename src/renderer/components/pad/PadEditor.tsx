import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import type { ContentRef } from "@shared/content";
import { contentObjectUrl } from "@shared/content-url";
import {
  applyPatches,
  type Pad,
  type PadElementId,
  type PadImage,
  type PadPatch,
  type PadPoint,
  type PadSide,
} from "@shared/pad";
import {
  anchorPoint,
  contentBounds,
  edgePoints,
  hitTest,
  identityCamera,
  sceneToView,
  strokePath,
  type Camera,
} from "@shared/pad-geom";
import {
  padInkStroke,
  padSvgPalette,
} from "@shared/pad-project";
import { themeMode$ } from "../../lib/theme-mode";
import { fileToClipboardImage } from "../../lib/clipboard-image";
import { putClipboardImage, putImagesFromDataTransfer } from "../../lib/image-content";
import { Kbd } from "../ui";
import { PadGlyph } from "./PadGlyph";
import { PadEdgeMark, PadShapeOutline, PadShapeWords } from "./PadMarks";
import { PadSelectionBar, PadToolbar, type PadToolbarSelection } from "./PadToolbar";
import { imageRow, restyleShape, stencilPatches, type PadShapeStyle, type PadStencilId } from "./pad-stencils";
import { openMention } from "../../lib/mention-open";
import type { MentionCandidate } from "../../lib/mention-draft";
import { state$ } from "../../lib/state";
import {
  dataTransferHasText,
  padCardFor,
  padCardSourceOfPick,
  padCardSourceOfText,
  padCardSourceOfTransfer,
  type PadCardSource,
} from "./pad-card";
import { PadCardPicker } from "./PadCardPicker";
import { PadCardShape, padCardRef } from "./PadCardShape";
import "./pad-editor.css";
import {
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
  areaFromDrag,
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
  moveImage,
  moveShape,
  nearestSide,
  newPadElementId,
  nextLayerZ,
  padIsEmpty,
  panBy,
  resizeImage,
  resizeShape,
  shapeById,
  sideHit,
  upsertEdgePatch,
  upsertImagePatch,
  upsertInkPatch,
  upsertShapePatch,
  viewSlop,
  wheelCamera,
  zOf,
  zPatch,
  type PadCommitOutcome,
  type PadShapeTool,
  type PadTool,
  type ResizeHandle,
} from "./pad-editor-model";
import { claimFocusOnMount, isOperatorTyping } from "../../lib/focus-ownership";

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
      readonly kind: "area";
      readonly start: PadPoint;
      readonly current: PadPoint;
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

/** An area on the pad, in pad units, top left and size. */
export type PadArea = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/**
 * What the P tool does. `area` drags a box and hands it to the host, writing
 * nothing. `none` has no P tool.
 */
export type PadPins =
  | { readonly kind: "area"; readonly onArea: (area: PadArea) => void }
  | { readonly kind: "none" };

export function PadEditor({
  pad: remotePad,
  pins,
  onCommit,
  onReadPad,
  onClose,
  cards,
}: {
  readonly pad: Pad;
  readonly pins: PadPins;
  /** Queued pad write; resolves with the authoritative outcome. */
  readonly onCommit: (patches: ReadonlyArray<PadPatch>) => Promise<PadCommitOutcome>;
  /** A fresh read through the host's acceptance path. */
  readonly onReadPad: () => Promise<Pad | null>;
  readonly onClose: () => void;
  /** What the @ list offers to put on the pad as a card. Absent, @ opens nothing; paste and drop still make cards. */
  readonly cards?: { readonly candidates: ReadonlyArray<MentionCandidate> };
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
  const pal = useMemo(() => padSvgPalette(theme), [theme]);
  const inkColor = defaultInkColor(theme);

  const selected = selectedId
    ? shapeById(pad, selectedId) ?? imageById(pad, selectedId)
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
      setCamera((current) => wheelCamera(current, event, view));
    };
    svg.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => {
      observer.disconnect();
      svg.removeEventListener("wheel", onNativeWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: wheel/resize bind to this SVG; originOf/fit read refs
  }, []);

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
      // Optimistic display; the authoritative pad replaces it at ack.
      const optimistic = applyPatches(base, patches);
      if (Result.isSuccess(optimistic)) setLocalPad(optimistic.success);
      const task: CommitTask = {
        operatorPatches: [...patches],
        inverse: Result.isSuccess(inverse) ? [...inverse.success] : [],
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
    await commit([deletePatch(selectedId as PadElementId)]);
    setSelectedId(undefined);
  }, [commit, selectedId, selectedLayer]);

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
      if (image) await commit([upsertImagePatch(moveImage(image, dx, dy))]);
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
      if (result.kind !== "ok" || result.refs.length === 0) return;
      if (result.refs.length === 1) {
        await placeRefAt(result.refs[0]!, scene);
        return;
      }
      // Several images land in one row, as one write and one undo.
      const z = nextLayerZ(padRef.current.images);
      const images = imageRow(result.refs.length, scene, DEFAULT_IMAGE_SIZE).map((box, index) => ({
        id: newPadElementId("image"),
        ...box,
        z: z + index,
        ref: result.refs[index]!,
      }));
      const ok = await commit(images.map(upsertImagePatch));
      if (ok) {
        setSelectedId(images[0]!.id);
        setHint(null);
      }
    },
    [commit, placeRefAt],
  );

  const canvasName = use$(state$.canvasName) || "";
  // Where the @ list was opened: the card it picks lands there.
  const [cardPicker, setCardPicker] = useState<PadPoint | null>(null);

  /** The scene point at the middle of the view: where a paste or an @ pick lands. */
  const viewCentre = (): PadPoint => {
    const origin = originOf();
    const rect = svgRef.current?.getBoundingClientRect();
    return clientToScene(
      camera,
      { x: origin.x + (rect?.width ?? DEFAULT_IMAGE_SIZE.w) / 2, y: origin.y + (rect?.height ?? DEFAULT_IMAGE_SIZE.h) / 2 },
      origin,
    );
  };

  /** A Junto thing onto the pad: one card shape, selected once it is written. */
  const placeCard = useCallback(
    async (source: PadCardSource, at: PadPoint): Promise<void> => {
      const { shape, patch } = padCardFor(source, at, padRef.current);
      setTool("select");
      await commit([patch]);
      setSelectedId(shape.id);
    },
    [commit],
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

  // Any shape but a card takes text, and an edge takes a label.
  const beginLabelEdit = useCallback((id?: string) => {
    const target = id ?? selectedId;
    if (!target) return;
    const shape = shapeById(padRef.current, target);
    const edge = shape ? undefined : padRef.current.edges.find((item) => item.id === target);
    if (shape ? shape.type === "card" : !edge) return;
    setSelectedId(target);
    setLabelDraft((shape ? shape.text : edge?.label) ?? "");
    setEditingLabel(true);
  }, [selectedId]);

  const finishLabelEdit = useCallback(
    async (save: boolean) => {
      setEditingLabel(false);
      if (!save || !selectedId) return;
      const text = labelDraft.trim();
      const shape = shapeById(padRef.current, selectedId);
      if (shape) {
        if (shape.type === "card" || text === (shape.text ?? "")) return;
        await commit([upsertShapePatch(restyleShape(shape, { text }))]);
        return;
      }
      const edge = padRef.current.edges.find((item) => item.id === selectedId);
      if (!edge || text === (edge.label ?? "")) return;
      const { label: _label, ...rest } = edge;
      await commit([upsertEdgePatch(text.length > 0 ? { ...rest, label: text } : rest)]);
    },
    [commit, labelDraft, selectedId],
  );

  const restyleSelected = useCallback(
    (style: PadShapeStyle) => {
      const shape = selectedId ? shapeById(padRef.current, selectedId) : undefined;
      if (!shape || shape.type === "card") return;
      const next = restyleShape(shape, style);
      if (JSON.stringify(next) === JSON.stringify(shape)) return;
      void commit([upsertShapePatch(next)]);
    },
    [commit, selectedId],
  );

  const insertStencil = (id: PadStencilId) => {
    // One batch: one write, one version, one undo frame.
    const { patches, ids } = stencilPatches(id, viewCentre(), nextLayerZ(padRef.current.shapes));
    setTool("select");
    void commit(patches).then((ok) => {
      if (ok) setSelectedId(ids[0]);
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === " " && !isOperatorTyping(event.target) && !isControlTarget(event.target)) {
        if (!event.repeat) setSpaceDown(true);
        event.preventDefault();
        return;
      }
      const typing = isOperatorTyping(event.target) || editingLabel;
      // @ on the pad opens the list of seats, tasks and artifacts to put here as a card.
      if (event.key === "@" && cards !== undefined && !typing && !isControlTarget(event.target) && cardPicker === null) {
        event.preventDefault();
        event.stopPropagation();
        setCardPicker(viewCentre());
        return;
      }
      if (typing && event.key === "Escape") {
        // Child inputs own Escape (the label input cancels itself). Do not
        // intercept.
        return;
      }
      const control = !typing && isControlTarget(event.target);
      const action = editorKeyAction(event, { typing, control });
      if (action) {
        event.preventDefault();
        event.stopPropagation();
      } else if (!typing) {
        // The pad surface owns the keyboard while open: a declined key must
        // not reach the crew canvas behind the modal — ReactFlow's
        // document-level deleteKeyCode deletes the selected node on
        // Backspace even when a pad control has focus. Only other listeners
        // are stopped; native behavior (focus move, button activation,
        // native Space/Enter) is preserved.
        event.stopPropagation();
      }
      switch (action?.type) {
        case "tool":
          if (action.tool === "area" && pins.kind === "none") return;
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
    cardPicker,
    cards,
    editingLabel,
    finishLabelEdit,
    gesture.kind,
    onClose,
    selectedId,
    undo,
  ]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isOperatorTyping(event.target) || editingLabel) return;
      if (!dataTransferHasImage(event.clipboardData)) {
        // A copied Junto link becomes a card in the middle of the view.
        const card = padCardSourceOfText(event.clipboardData?.getData("text/plain") ?? "");
        if (card === undefined) return;
        event.preventDefault();
        event.stopPropagation();
        void placeCard(card, viewCentre());
        return;
      }
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
  }, [camera, editingLabel, ingestTransfer, placeCard]);

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
    if (tool === "area") {
      setGesture({ kind: "area", start: scene, current: scene });
      setSelectedId(undefined);
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
      const item = shapeById(pad, hit.id) ?? imageById(pad, hit.id);
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
    if (gesture.kind === "draw" || gesture.kind === "area") {
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
    if (current.kind === "area") {
      // An area pick writes nothing; a bare click picks no area.
      const area = areaFromDrag(current.start, scene);
      if (pins.kind === "area" && area !== undefined) pins.onArea(area);
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

  const editedEdge = editingLabel && !shownSelected && selectedId
    ? shown.edges.find((edge) => edge.id === selectedId)
    : undefined;
  const labelView = (() => {
    if (!editingLabel) return undefined;
    if (shownSelected) {
      const view = sceneToView(camera, { x: shownSelected.x, y: shownSelected.y });
      return { left: view.x, top: view.y, width: shownSelected.w * camera.zoom };
    }
    const points = editedEdge ? edgePoints(shown, editedEdge) : undefined;
    const mid = points?.[Math.floor(points.length / 2)];
    if (!mid) return undefined;
    const view = sceneToView(camera, mid);
    return { left: view.x - 60, top: view.y - 12, width: 120 };
  })();

  const selectedShape = selectedId ? shapeById(pad, selectedId) : undefined;
  const selectedEdge = selectedId && !selectedShape
    ? pad.edges.find((edge) => edge.id === selectedId)
    : undefined;
  const toolbarSelection: PadToolbarSelection | undefined =
    selectedShape && selectedShape.type !== "card"
      ? { layer: "shape", shape: selectedShape }
      : selectedEdge
        ? { layer: "edge", edge: selectedEdge }
        : undefined;

  return (
    <div className="pad-surface__body">
      <PadToolbar
        tool={tool}
        onTool={setTool}
        areaTool={pins.kind === "area"}
        canUndo={undoDepth > 0 && !commitBusy}
        onUndo={undo}
        onFit={fit}
        onStencil={insertStencil}
      />
      {toolbarSelection && gesture.kind === "idle" ? (
        <PadSelectionBar
          selection={toolbarSelection}
          onRestyle={restyleSelected}
          onEditText={() => beginLabelEdit()}
        />
      ) : null}
      <div className="pad-workspace">
      <div
        className="pad-stage"
        onDragOver={(event) => {
          if (!dataTransferHasImage(event.dataTransfer) && !dataTransferHasText(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(event) => {
          if (!dataTransferHasImage(event.dataTransfer)) {
            // A dropped Junto link becomes a card where it lands; any other text is not the pad's.
            const card = padCardSourceOfTransfer(event.dataTransfer);
            if (card === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            void placeCard(card, sceneOf(event));
            return;
          }
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
            const shape = hit ? shapeById(pad, hit.id) : undefined;
            if (shape?.type === "card") {
              // A card opens what it names; a gone one opens nothing.
              const ref = padCardRef(shape, canvasName);
              if (ref !== undefined) openMention(ref);
            } else if (hit && (hit.layer === "shape" || hit.layer === "edge")) {
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
              return points ? (
                <PadEdgeMark key={edge.id} edge={edge} points={points} pal={pal} selected={edge.id === selectedId} />
              ) : null;
            })}
            {shown.shapes
              .slice()
              .sort((a, b) => a.z - b.z)
              .map((shape) => (
                <g key={shape.id} data-testid="pad-shape" data-shape-id={shape.id} data-shape-type={shape.type}>
                  {shape.type === "card" ? (
                    <PadCardShape shape={shape} canvasName={canvasName} selected={shape.id === selectedId} />
                  ) : (
                    <>
                      <PadShapeOutline shape={shape} pal={pal} selected={shape.id === selectedId} />
                      {editingLabel && shape.id === selectedId ? null : <PadShapeWords shape={shape} pal={pal} />}
                    </>
                  )}
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
                      : padInkStroke(ink.color, pal)
                  }
                  strokeWidth={ink.id === selectedId ? ink.width + 1 : ink.width}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            {gesture.kind === "area" ? (
              (() => {
                const area = areaFromDrag(gesture.start, gesture.current);
                return area ? (
                  <rect
                    data-testid="pad-area-draft"
                    x={area.x}
                    y={area.y}
                    width={area.w}
                    height={area.h}
                    fill="none"
                    stroke="var(--color-amber)"
                    strokeDasharray="3 2"
                    vectorEffect="non-scaling-stroke"
                  />
                ) : null;
              })()
            ) : null}
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
        {cardPicker !== null && cards !== undefined ? (
          <div className="pad-card-picker-anchor">
            <PadCardPicker
              candidates={cards.candidates}
              onClose={() => setCardPicker(null)}
              onPick={(pick) => {
                const at = cardPicker;
                setCardPicker(null);
                void placeCard(padCardSourceOfPick(pick, canvasName), at);
              }}
            />
          </div>
        ) : null}
        {empty && gesture.kind === "idle" ? (
          <div className="pad-empty" data-testid="pad-empty">
            <PadGlyph className="pad-empty__mark" />
            <strong>Mark the page</strong>
            <span>
              {pins.kind === "area"
                ? "Draw boxes, drop images, ink, and comment on an area."
                : "Draw boxes, drop images, and ink."}
            </span>
            <div className="pad-empty__keys">
              <span><Kbd>R</Kbd> box</span>
              <span><Kbd>O</Kbd> ellipse</span>
              <span><Kbd>T</Kbd> triangle</span>
              <span><Kbd>L</Kbd> label</span>
              {pins.kind === "area" ? <span><Kbd>P</Kbd> comment</span> : null}
              <span><Kbd>I</Kbd> image</span>
              <span><Kbd>D</Kbd> ink</span>
            </div>
          </div>
        ) : null}
        <div className="pad-hint" role="status" aria-live="polite" data-empty={hint ? undefined : "true"}>
          {hint}
        </div>
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
            ref={claimFocusOnMount}
            aria-label={editedEdge ? "Edge label" : "Shape text"}
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
      </div>
    </div>
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
        strokeDasharray="4 3"
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
          rx={2 / Math.max(zoom, 0.0001)}
          fill="var(--color-raise-2)"
          stroke="var(--color-amber)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}
