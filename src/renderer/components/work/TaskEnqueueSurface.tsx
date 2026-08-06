import { useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Pin, PinOff, X } from "lucide-react";
import type { CanvasNode, Part, WorkMetadata } from "@shared/canvas";
import type { WorkOpResult } from "@shared/ipc";
import { workRolesInDoc } from "@shared/attention";
import type { WorkSurface, WorkZone } from "../../lib/surface-registry";
import {
  closeWorkbenchSurface,
  dock$,
  pinWorkbenchSurface,
  unpinWorkbenchSurface,
} from "../../lib/dock-state";
import { applyWorkCanvasWrite } from "../../lib/mutations";
import { runCanvasAuthoringOperation } from "../../lib/canvas-editor-flush";
import { activateSurfaceOnMouseDown } from "../../lib/pointer-activation";
import { state$ } from "../../lib/state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { IconButton } from "../ui";
import {
  resolveArtifactsNodeId,
  TaskCreateDialog,
} from "./TaskBoard";
import "./task-board.css";

const canvasName = (): string => state$.canvasName.peek() || "";

const acceptWorkResult = <T,>(canvas: string, result: WorkOpResult<T>): WorkOpResult<T> => {
  if (result.ok) applyWorkCanvasWrite(canvas, result.doc, result.revision);
  return result;
};

const runWorkCanvasMutation = <T,>(
  canvas: string,
  operation: () => Promise<WorkOpResult<T>>,
): Promise<WorkOpResult<T> | undefined> =>
  runCanvasAuthoringOperation(async () => acceptWorkResult(canvas, await operation()));

/**
 * Workbench pane: quick enqueue for a tasks sink.
 * Pin-able, coexists with a pinned terminal (and vice versa).
 * Successful create clears the form and keeps the surface open.
 */
export function TaskEnqueueSurface({
  surface,
  zone,
  visible,
  onActivate,
}: {
  readonly surface: WorkSurface;
  readonly zone: WorkZone;
  readonly visible: boolean;
  readonly onActivate: () => void;
}) {
  const payload = dock$.taskCreateById[surface.id].peek();
  const doc = use$(state$.doc);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [resetToken, setResetToken] = useState(0);
  const api = getVellumCommandApi();
  const name = canvasName();

  const node = useMemo((): CanvasNode | undefined => {
    if (!payload) return undefined;
    return doc.nodes.find((entry) => entry.id === payload.nodeId);
  }, [doc.nodes, payload]);

  const roles = useMemo(() => workRolesInDoc(doc), [doc]);
  const artifactsNodeId = useMemo(
    () => (node ? resolveArtifactsNodeId(node.id, doc) : undefined),
    [doc, node],
  );

  if (!payload || !node) {
    return (
      <section className="dock-slot workbench-surface">
        <div className="workbench-surface__placeholder">task enqueue - unbound</div>
      </section>
    );
  }

  const pinned = zone === "pinned";
  const mode = payload.mode;

  const create = async (
    title: string,
    details: string,
    role: string,
    media: ReadonlyArray<Extract<Part, { kind: "raw" }>>,
    dependsOn: ReadonlyArray<string>,
    finishCriteria: import("@shared/work-model").FinishCriteria | undefined,
  ) => {
    if (!api || !title.trim() || !details.trim()) return;
    setError("");
    setPending(true);
    try {
      const metadata: WorkMetadata = {
        title: title.trim(),
        details: details.trim(),
        ...(role.trim() ? { workRole: role.trim() } : {}),
      };
      if (mode === "proposal") {
        const result = await runWorkCanvasMutation(name, () =>
          api.workTaskPropose(
            name,
            node.id,
            title.trim(),
            metadata,
            undefined,
            media.length > 0 ? media : undefined,
            dependsOn.length > 0 ? dependsOn : undefined,
            finishCriteria,
          ),
        );
        if (result === undefined) return;
        if (!result.ok) {
          setError(result.message);
          return;
        }
      } else {
        const result = await runWorkCanvasMutation(name, () =>
          api.workTaskCreate(
            name,
            node.id,
            title.trim(),
            metadata,
            undefined,
            media.length > 0 ? media : undefined,
            dependsOn.length > 0 ? dependsOn : undefined,
            finishCriteria,
          ),
        );
        if (result === undefined) return;
        if (!result.ok) {
          setError(result.message);
          return;
        }
      }
      // Stay open — clear for the next enqueue.
      setResetToken((token) => token + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const actions = (
    <>
      <IconButton
        size="md"
        aria-label={pinned ? "Unpin task enqueue" : "Pin task enqueue"}
        title={pinned ? "Move to focus" : "Pin to side dock"}
        onClick={() => {
          if (pinned) unpinWorkbenchSurface(surface.id);
          else pinWorkbenchSurface(surface.id);
        }}
      >
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </IconButton>
      <IconButton
        size="md"
        tone="danger"
        aria-label="Close task enqueue"
        title="Close"
        onClick={() => closeWorkbenchSurface(surface.id)}
        disabled={pending}
      >
        <X size={14} />
      </IconButton>
    </>
  );

  return (
    <section
      className="dock-slot dock-slot--task-create workbench-surface"
      aria-label={`Quick enqueue - ${payload.title}`}
      aria-hidden={!visible}
      data-testid="task-enqueue-surface"
      onMouseDown={activateSurfaceOnMouseDown(onActivate)}
    >
      {error ? (
        <div className="task-board-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      ) : null}
      <TaskCreateDialog
        mode={mode}
        roles={roles}
        pending={pending}
        artifactsNodeId={artifactsNodeId}
        shell="inline"
        stayOpen
        resetToken={resetToken}
        headerActions={actions}
        onClose={() => {
          if (!pending) closeWorkbenchSurface(surface.id);
        }}
        onCreate={(title, details, role, media, dependsOn, finishCriteria) => {
          void create(title, details, role, media, dependsOn, finishCriteria);
        }}
      />
    </section>
  );
}
