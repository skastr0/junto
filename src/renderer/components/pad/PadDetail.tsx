import { useCallback, useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { Pad, PadPatch } from "@shared/pad";
import type { WorkOpResult } from "@shared/ipc";
import { FocusSurface } from "../FocusSurface";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { state$ } from "../../lib/state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import type { PadCommitOutcome } from "./pad-editor-model";
import { PadEditor } from "./PadEditor";
import "./pad-editor.css";

const canvasName = (): string => state$.canvasName.peek() || "";

const acceptWorkResult = <T,>(canvas: string, result: WorkOpResult<T>): WorkOpResult<T> => {
  if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
  return result;
};

export function PadDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const rawText = node.type === "text" ? node.text : "";
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
      const api = getVellumCommandApi();
      if (!api) {
        setError("Vellum Command work plane is unavailable.");
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

  // Live refresh: every work-plane patch advances this node's pad glance
  // revision in the factory doc. Refresh while the surface is open so agent
  // patches appear without reopening. Own commits reach acceptance through
  // `onCommit`; the read here only confirms or clears the undo baseline.
  const docNodes = use$(state$.doc.nodes);
  const glanceRevision = docNodes.find((candidate) => candidate.id === node.id)?.ether?.pad
    ?.revision;
  useEffect(() => {
    if (glanceRevision === undefined || glanceRevision <= acceptedRevisionRef.current) return;
    void readPad();
  }, [glanceRevision, readPad]);

  const onCommit = useCallback(
    async (patches: ReadonlyArray<PadPatch>): Promise<PadCommitOutcome> => {
      const api = getVellumCommandApi();
      if (!api) {
        return { ok: false, message: "Vellum Command work plane is unavailable." };
      }
      setError(null);
      commitInFlightRef.current = true;
      try {
        const result = await runCanvasAuthoringOperation(async () =>
          acceptWorkResult(canvasName(), await api.workPadPatch(canvasName(), node.id, patches)),
        );
        if (!result) {
          return { ok: false, message: "Vellum Command work plane is unavailable." };
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
      layer="work"
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
