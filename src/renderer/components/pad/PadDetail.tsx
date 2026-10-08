import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { NodeOf } from "@shared/model";
import type { Pad, PadPatch } from "@shared/pad";
import type { WorkOpResult } from "@shared/ipc";
import { FocusSurface } from "../FocusSurface";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { state$ } from "../../lib/state";
import { getJuntoApi } from "../../lib/junto-api";
import type { PadCommitOutcome } from "./pad-editor-model";
import { PadEditor } from "./PadEditor";
import "./pad-editor.css";

const canvasName = (): string => state$.canvasName.peek() || "";

export function PadDetail({
  node,
  onClose,
}: {
  readonly node: NodeOf<"pad">;
  readonly onClose: () => void;
}) {
  const rawText = node.label ?? "";
  const title = rawText.split("\n")[0]?.trim() || "Pad";
  const [pad, setPad] = useState<Pad | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  // Highest accepted pad revision; reads never roll this back.
  const acceptedRevisionRef = useRef(0);
  const readSeqRef = useRef(0);
  const loadedRef = useRef(false);
  const commitInFlightRef = useRef(false);
  const pendingRefreshRef = useRef(false);

  const acceptPad = useCallback((next: Pad): void => {
    if (next.revision < acceptedRevisionRef.current) return;
    acceptedRevisionRef.current = next.revision;
    setPad(next);
  }, []);

  /**
   * Single pad-read acceptance path. With a pinId it also marks that pin
   * thread read (the IPC handler does both in one call). Returns the pad so
   * the editor can recover from stale-base rejections.
   */
  const readPad = useCallback(
    async (pinId?: string): Promise<Pad | null> => {
      if (commitInFlightRef.current) {
        pendingRefreshRef.current = true;
        return null;
      }
      const api = getJuntoApi();
      if (!api) {
        setError("Junto work plane is unavailable.");
        return null;
      }
      const seq = ++readSeqRef.current;
      setRefreshing(true);
      try {
        const result = await api.workPadRead(canvasName(), node.id, pinId);
        if (seq !== readSeqRef.current) return null;
        if (!result.ok) {
          if (!loadedRef.current) setError(result.message);
          return null;
        }
        acceptPad(result.data.pad);
        loadedRef.current = true;
        setError(null);
        return result.data.pad;
      } catch (err) {
        if (seq === readSeqRef.current && !loadedRef.current) {
          setError(err instanceof Error ? err.message : "Pad read failed.");
        }
        return null;
      } finally {
        if (seq === readSeqRef.current) setRefreshing(false);
      }
    },
    [acceptPad, node.id],
  );

  useEffect(() => {
    void readPad();
  }, [readPad]);

  // A committed patch names this pad; it never invalidates canvas geometry.
  useEffect(() => {
    const api = getJuntoApi();
    if (!api) return;
    return api.onWorkSinkChanged((event) => {
      if (event.canvasName === canvasName() && event.nodeId === node.id) void readPad();
    });
  }, [node.id, readPad]);

  const onCommit = useCallback(
    async (patches: ReadonlyArray<PadPatch>): Promise<PadCommitOutcome> => {
      const api = getJuntoApi();
      if (!api) {
        return { ok: false, message: "Junto work plane is unavailable." };
      }
      setError(null);
      commitInFlightRef.current = true;
      try {
        const result = await runCanvasAuthoringOperation(async () =>
          api.workPadPatch(canvasName(), node.id, patches),
        );
        if (!result) {
          return { ok: false, message: "Junto work plane is unavailable." };
        }
        if (!result.ok) {
          return { ok: false, code: result.code, message: result.message };
        }
        acceptPad(result.data.pad);
        return { ok: true, pad: result.data.pad };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : "Pad write failed.",
        };
      } finally {
        commitInFlightRef.current = false;
        if (pendingRefreshRef.current) {
          pendingRefreshRef.current = false;
          void readPad();
        }
      }
    },
    [acceptPad, node.id, readPad],
  );

  return (
    <FocusSurface
      label="Pad"
      measure="workspace"
      height="immersive"
      onClose={onClose}
      closeOnEscape={false}
    >
      <div className="pad-surface flex h-full min-h-0 flex-col" data-testid="pad-detail">
        <OverlayHeader
          eyebrow="pad"
          title={title}
          status={
            pad
              ? `${pad.shapes.length} ${pad.shapes.length === 1 ? "shape" : "shapes"} - rev ${pad.revision}`
              : refreshing
                ? "loading"
                : "unavailable"
          }
          actions={
            <IconButton aria-label="Close pad" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          }
        />
        {error ? <div className="pad-error">{error}</div> : null}
        {pad ? (
          <PadEditor
            pad={pad}
            padNodeId={node.id}
            onCommit={onCommit}
            onReadPad={readPad}
            onClose={onClose}
          />
        ) : (
          <div className="pad-surface__body" data-testid="pad-detail-loading" />
        )}
      </div>
    </FocusSurface>
  );
}
