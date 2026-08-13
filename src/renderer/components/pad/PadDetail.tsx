import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { emptyPad, type Pad, type PadPatch } from "@shared/pad";
import type { WorkOpResult } from "@shared/ipc";
import { FocusSurface } from "../FocusSurface";
import { IconButton } from "../ui/IconButton";
import { OverlayHeader } from "../ui/OverlayHeader";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { state$ } from "../../lib/state";
import { getVellumCommandApi } from "../../lib/vellum-api";
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
  const [pad, setPad] = useState<Pad>(emptyPad());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const api = getVellumCommandApi();
    if (!api) {
      setError("Vellum Command work plane is unavailable.");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await api.workPadRead(canvasName(), node.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setPad(result.data.pad);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [node.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCommit = async (patches: ReadonlyArray<PadPatch>): Promise<boolean> => {
    const api = getVellumCommandApi();
    if (!api) {
      setError("Vellum Command work plane is unavailable.");
      return false;
    }
    setError(null);
    const result = await runCanvasAuthoringOperation(async () =>
      acceptWorkResult(canvasName(), await api.workPadPatch(canvasName(), node.id, patches)),
    );
    if (!result) {
      setError("Vellum Command work plane is unavailable.");
      return false;
    }
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setPad(result.data.pad);
    return true;
  };

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
            loading
              ? "loading"
              : `${pad.shapes.length} ${pad.shapes.length === 1 ? "shape" : "shapes"} - rev ${pad.revision}`
          }
          actions={
            <IconButton aria-label="Close pad" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          }
        />
        {error ? <div className="pad-error">{error}</div> : null}
        <PadEditor
          pad={pad}
          padNodeId={node.id}
          onCommit={onCommit}
          onClose={onClose}
        />
      </div>
    </FocusSurface>
  );
}
