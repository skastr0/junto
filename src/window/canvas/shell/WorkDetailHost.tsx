/**
 * The host for work detail surfaces under the GPU canvas (docs/canvas-gpu-
 * architecture.md, section 16). Today those surfaces mount inside a card's
 * React tree; the GPU canvas has no card trees, so this host owns them.
 *
 * Mounted by the app beside the canvas, not by the shell host, so the canvas
 * host's import graph stays clear of card components. It consumes the same
 * `workDetailOpen$` trigger the cards consume, and only while the switch is on:
 * with the old canvas mounted the card is the one that opens.
 */

import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { consumeWorkDetailOpen, filesDetailOpening, workDetailOpen$ } from "../../lib/work-detail-open";
import { useNode } from "../../lib/use-model";
import { state$ } from "../../lib/state";
import { useFeatureOn } from "../../lib/experimental-features";
import { TasksDetail, ArtifactsDetail, AutomationsDetail } from "../../components/work/WorkSurfaces";
import { GitDetail } from "../../components/git/GitDetail";
import { FilesDetail } from "../../components/files/FilesDetail";

type Open = {
  readonly nodeId: string;
  readonly itemId?: string;
  readonly page?: number;
  readonly firingId?: string;
  readonly openKey: number;
};

export function WorkDetailHost() {
  const on = useFeatureOn("gpuCanvas");
  const canvasName = use$(state$.canvasName);
  const target = use$(workDetailOpen$.nodeId);
  const [open, setOpen] = useState<Open | null>(null);
  const node = useNode(canvasName, open?.nodeId ?? "");

  useEffect(() => {
    if (!on || target === "") return;
    const consumed = consumeWorkDetailOpen(target);
    if (consumed === null) return;
    const opening = filesDetailOpening(consumed);
    setOpen({ nodeId: target, ...opening, ...(consumed.firingId === undefined ? {} : { firingId: consumed.firingId }) });
  }, [on, target]);

  useEffect(() => {
    if (open !== null && node === undefined) setOpen(null);
  }, [open, node]);

  if (!on || open === null || node === undefined) return null;
  const close = (): void => setOpen(null);

  if (node.kind === "task") {
    return <TasksDetail nodeId={open.nodeId} initialItemId={open.itemId} openKey={open.openKey} onClose={close} />;
  }
  if (node.kind === "artifacts") {
    return <ArtifactsDetail nodeId={open.nodeId} initialItemId={open.itemId} openKey={open.openKey} onClose={close} />;
  }
  if (node.kind === "automations") {
    return (
      <AutomationsDetail
        nodeId={open.nodeId}
        initialAutomationId={open.itemId}
        {...(open.firingId === undefined ? {} : { initialFiringId: open.firingId })}
        openKey={open.openKey}
        onClose={close}
      />
    );
  }
  if (node.kind === "files") {
    return (
      <FilesDetail
        nodeId={open.nodeId}
        initialItemId={open.itemId}
        openKey={open.openKey}
        {...(open.page === undefined ? {} : { initialPage: open.page })}
        onClose={close}
      />
    );
  }
  if (node.kind === "git") {
    return <GitDetail node={node} onClose={close} />;
  }
  return null;
}
