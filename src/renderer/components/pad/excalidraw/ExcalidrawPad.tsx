import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { Result } from "effect";
import {
  CaptureUpdateAction,
  Excalidraw,
  restoreElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, FileId } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import { MessageSquare } from "lucide-react";
import { contentObjectUrl } from "@shared/content-url";
import { parseMentionHref } from "@shared/mention";
import { applyPatches, type Pad, type PadPatch } from "@shared/pad";
import { padSvgPalette } from "@shared/pad-project";
import { themeMode$ } from "../../../lib/theme-mode";
import { fileToClipboardImage } from "../../../lib/clipboard-image";
import { putClipboardImage } from "../../../lib/image-content";
import type { PadCommitOutcome } from "../pad-editor-model";
import type { PadArea } from "../PadEditor";
import { PadCard } from "./PadCard";
import {
  PAD_FONT_FAMILY,
  PAD_STROKE_WIDTH,
  padDiff,
  padToScene,
  sceneToPad,
  settle,
  type JuntoData,
  type SceneElement,
} from "./pad-excalidraw-model";
import "./excalidraw-pad.css";

// Fonts come from the app, never a CDN: the renderer's CSP allows 'self' only.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = new URL(
  "./excalidraw/",
  window.location.href,
).href;

/** How long the scene rests after a gesture before it is written as one version. */
const WRITE_REST_MS = 250;

type AppStateLike = Record<string, unknown> & {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: { readonly value: number };
  readonly offsetLeft: number;
  readonly offsetTop: number;
};

/** A gesture is still running: a drag, a resize, a stroke, text being typed. */
const gestureRunning = (appState: Record<string, unknown>): boolean =>
  Boolean(
    appState.newElement ||
      appState.resizingElement ||
      appState.multiElement ||
      appState.editingTextElement ||
      appState.selectedElementsAreBeingDragged ||
      appState.isResizing ||
      appState.isRotating,
  );

const dataUrlBlob = (dataURL: string): Blob => {
  const [head, body = ""] = dataURL.split(",", 2);
  const mime = /data:([^;]+)/u.exec(head ?? "")?.[1] ?? "application/octet-stream";
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
};

const blobDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/**
 * The pad drawn on Excalidraw (spike behind the dev pad engine switch). The
 * pad IR stays the stored truth: the scene is drawn from it, and once a
 * gesture rests the scene is read back and its difference sent as pad
 * patches, one ruled write and one version. A write from elsewhere lands as
 * a scene update outside the operator's undo.
 */
export function ExcalidrawPad({
  pad: remotePad,
  onCommit,
  onCommentBox,
}: {
  readonly pad: Pad;
  readonly onCommit: (patches: ReadonlyArray<PadPatch>) => Promise<PadCommitOutcome>;
  readonly onCommentBox?: (area: PadArea) => void;
}) {
  const theme = use$(themeMode$);
  const pal = useMemo(() => padSvgPalette(theme), [theme]);
  const palRef = useRef(pal);
  palRef.current = pal;
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The pad the scene was last in step with: every diff is taken from it. */
  const baseRef = useRef(remotePad);
  /** Element versions at the last sync; a newer one is the operator's change. */
  const syncedRef = useRef(new Map<string, number>());
  /** The next onChange after a scene load only records versions. */
  const resyncRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const [status, setStatus] = useState<string | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [area, setArea] = useState<{ readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number } | null>(null);

  const initialData = useMemo(
    () => ({
      elements: restoreElements(padToScene(remotePad, pal) as unknown as ExcalidrawElement[], null, { repairBindings: true }),
      appState: {
        viewBackgroundColor: pal.ground,
        currentItemStrokeColor: pal.text,
        currentItemBackgroundColor: "transparent",
        currentItemFillStyle: "solid" as const,
        currentItemStrokeWidth: PAD_STROKE_WIDTH,
        currentItemRoughness: 0,
        currentItemFontFamily: PAD_FONT_FAMILY,
        currentItemRoundness: "round" as const,
      },
      scrollToContent: true,
    }),
    // Only the first pad seeds the scene; later ones arrive as updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const recordVersions = (elements: ReadonlyArray<ExcalidrawElement>): void => {
    syncedRef.current = new Map(elements.map((element) => [element.id, element.version]));
  };

  /** Draw a pad as the scene, keeping what the pad cannot hold. */
  const loadPad = useCallback((pad: Pad, keepIds: ReadonlyArray<string> = []) => {
    const api = apiRef.current;
    if (!api) return;
    const local = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
    const drawn = padToScene(pad, palRef.current).map((element) => {
      const was = local.get(element.id);
      return was ? { ...element, version: was.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31) } : element;
    });
    const kept = keepIds.map((id) => local.get(id)).filter((element) => element !== undefined);
    resyncRef.current = true;
    api.updateScene({
      elements: restoreElements([...(drawn as unknown as ExcalidrawElement[]), ...kept], null, { repairBindings: true }),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    void loadFiles(pad);
  }, []);

  /** Give the scene the bytes of every image the pad holds. */
  const loadFiles = async (pad: Pad): Promise<void> => {
    const api = apiRef.current;
    if (!api) return;
    const have = api.getFiles();
    const missing = pad.images.filter((image) => have[image.ref.sha256] === undefined);
    const files: BinaryFileData[] = [];
    for (const image of missing) {
      const response = await fetch(contentObjectUrl(image.ref)).catch(() => null);
      if (!response?.ok) continue;
      files.push({
        id: image.ref.sha256 as string as FileId,
        dataURL: (await blobDataUrl(await response.blob())) as DataURL,
        mimeType: image.ref.mediaType as BinaryFileData["mimeType"],
        created: Date.now(),
      });
    }
    if (files.length > 0) api.addFiles(files);
  };

  /** Store a pasted image's bytes, then mark its element with the content ref. */
  const storeImage = async (elementId: string, fileId: string): Promise<boolean> => {
    const api = apiRef.current;
    const file = api?.getFiles()[fileId];
    if (!api || !file) return false;
    const blob = dataUrlBlob(file.dataURL);
    const image = await fileToClipboardImage(new File([blob], `pasted.${blob.type.split("/")[1] ?? "png"}`, { type: blob.type }));
    if ("error" in image) {
      setStatus(image.error);
      return false;
    }
    const put = await putClipboardImage(image, "pasted image");
    if (!put.ok) {
      setStatus(put.error);
      return false;
    }
    // The stored bytes are the scene's file under the content's own name.
    api.addFiles([{ ...file, id: put.ref.sha256 as string as FileId }]);
    const elements = api.getSceneElementsIncludingDeleted().map((element) =>
      element.id === elementId
        ? {
            ...element,
            fileId: put.ref.sha256 as string as FileId,
            customData: { ...element.customData, junto: { ...(element.customData?.junto as JuntoData | undefined), ref: put.ref } },
            version: element.version + 1,
            versionNonce: Math.floor(Math.random() * 2 ** 31),
          }
        : element,
    );
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
    return true;
  };

  /** Read the scene back and send what changed as one write. */
  const write = useCallback(async (): Promise<void> => {
    const api = apiRef.current;
    if (!api) return;
    const elements = api.getSceneElementsIncludingDeleted() as unknown as ReadonlyArray<SceneElement>;
    const synced = syncedRef.current;
    const changed = new Set<string>();
    for (const element of elements) {
      if (synced.get(element.id) === element.version) continue;
      changed.add(element.id);
      if (typeof element.containerId === "string") changed.add(element.containerId);
    }
    if (changed.size === 0) return;
    const base = baseRef.current;
    const read = sceneToPad(base, elements, palRef.current);
    for (const image of read.unstored) {
      if (await storeImage(image.id, image.fileId)) return; // its own update brings another write
    }
    const next = settle(base, read.pad, changed);
    const patches = padDiff(base, next);
    recordVersions(api.getSceneElementsIncludingDeleted());
    setStatus(read.unsaved.length > 0 ? `${String(read.unsaved.length)} not saved: the pad cannot hold them yet` : null);
    if (patches.length === 0) return;
    const optimistic = applyPatches(base, patches);
    if (Result.isFailure(optimistic)) {
      setStatus(optimistic.failure.message);
      return;
    }
    baseRef.current = optimistic.success;
    const outcome = await onCommit(patches);
    if (outcome.ok) {
      baseRef.current = outcome.pad;
      return;
    }
    // Refused: say why and show the pad as it stands.
    setStatus(outcome.message);
    baseRef.current = base;
    loadPad(base, read.unsaved);
  }, [loadPad, onCommit]);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      chainRef.current = chainRef.current.then(write, write);
    }, WRITE_REST_MS);
  }, [write]);

  // A pad from elsewhere (an agent's patch, a restore): drawn unless it is our own write's echo.
  useEffect(() => {
    const base = baseRef.current;
    if (padDiff(base, remotePad).length === 0) {
      baseRef.current = { ...base, revision: remotePad.revision };
      return;
    }
    baseRef.current = remotePad;
    const unsaved = apiRef.current
      ? sceneToPad(remotePad, apiRef.current.getSceneElementsIncludingDeleted() as unknown as SceneElement[], palRef.current).unsaved
      : [];
    loadPad(remotePad, unsaved);
  }, [remotePad, loadPad]);

  // A theme change repaints every color the pad leaves to the theme.
  const themeSeen = useRef(theme);
  useEffect(() => {
    if (themeSeen.current === theme) return;
    themeSeen.current = theme;
    apiRef.current?.updateScene({ appState: { viewBackgroundColor: pal.ground, currentItemStrokeColor: pal.text }, captureUpdate: CaptureUpdateAction.NEVER });
    loadPad(baseRef.current);
  }, [theme, pal, loadPad]);

  useEffect(() => () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      void write();
    }
  }, [write]);

  const onChange = (elements: ReadonlyArray<ExcalidrawElement>, appState: Record<string, unknown>): void => {
    if (resyncRef.current) {
      resyncRef.current = false;
      recordVersions(elements);
      return;
    }
    if (gestureRunning(appState)) {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      return;
    }
    let moved = false;
    for (const element of elements) {
      if (syncedRef.current.get(element.id) !== element.version) {
        moved = true;
        break;
      }
    }
    if (moved || elements.length !== syncedRef.current.size) schedule();
  };

  const sceneAt = (event: { clientX: number; clientY: number }) =>
    viewportCoordsToSceneCoords(event, apiRef.current!.getAppState());

  const areaHandlers = {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      const at = sceneAt(event);
      setArea({ x0: at.x, y0: at.y, x1: at.x, y1: at.y });
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!area) return;
      const at = sceneAt(event);
      setArea({ ...area, x1: at.x, y1: at.y });
    },
    onPointerUp: () => {
      if (area && onCommentBox) {
        const box = { x: Math.min(area.x0, area.x1), y: Math.min(area.y0, area.y1), w: Math.abs(area.x1 - area.x0), h: Math.abs(area.y1 - area.y0) };
        if (box.w > 4 && box.h > 4) onCommentBox(box);
      }
      setArea(null);
      setAreaMode(false);
    },
  };

  const areaView = (() => {
    if (!area || !apiRef.current) return null;
    const state = apiRef.current.getAppState() as unknown as AppStateLike;
    const zoom = state.zoom.value;
    const left = (Math.min(area.x0, area.x1) + state.scrollX) * zoom;
    const top = (Math.min(area.y0, area.y1) + state.scrollY) * zoom;
    return { left, top, width: Math.abs(area.x1 - area.x0) * zoom, height: Math.abs(area.y1 - area.y0) * zoom };
  })();

  return (
    <div
      ref={rootRef}
      className="excalidraw-pad"
      data-testid="excalidraw-pad"
      data-theme-mode={theme}
      // The pad keeps its keys: none reaches the canvas behind the modal.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => {
          apiRef.current = api;
          void loadFiles(remotePad);
          // The keyboard's way into the pane lands on the drawing.
          requestAnimationFrame(() => rootRef.current?.querySelector(".excalidraw-container")?.setAttribute("data-pane-entry", ""));
        }}
        onChange={(elements, appState) => onChange(elements, appState as unknown as Record<string, unknown>)}
        theme={theme === "bright" ? "light" : "dark"}
        handleKeyboardGlobally={false}
        autoFocus={false}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false,
            clearCanvas: false,
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            toggleTheme: false,
            saveAsImage: false,
          },
          tools: { image: true },
        }}
        validateEmbeddable={(link) => (parseMentionHref(link) !== undefined ? true : undefined)}
        renderEmbeddable={(element) => (element.link && parseMentionHref(element.link) ? <PadCard href={element.link} /> : null)}
        renderTopRightUI={() => (
          <div className="excalidraw-pad__top">
            {status ? (
              <span className="excalidraw-pad__status" role="status">
                {status}
              </span>
            ) : null}
            {onCommentBox ? (
              <button
                type="button"
                className="excalidraw-pad__tool"
                aria-pressed={areaMode}
                aria-label="Comment on an area"
                title="Comment on an area"
                data-testid="excalidraw-pad-area"
                onClick={() => setAreaMode(!areaMode)}
              >
                <MessageSquare size={14} aria-hidden />
              </button>
            ) : null}
          </div>
        )}
      />
      {areaMode ? (
        <div className="excalidraw-pad__area-layer" data-testid="excalidraw-pad-area-layer" {...areaHandlers}>
          {areaView ? <div className="excalidraw-pad__area" style={areaView} /> : null}
        </div>
      ) : null}
    </div>
  );
}
