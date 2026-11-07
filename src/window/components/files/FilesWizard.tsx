import { useState } from "react";
import { resolveRegionCwd } from "@shared/region-defaults";
import { featureOnNow } from "../../lib/experimental-features";
import { isAbsoluteFolder, newFiles } from "../../lib/model-factories";
import { topZ } from "../../lib/model-edits";
import { thisMachineName } from "../../lib/machines";
import { addNode } from "../../lib/mutations";
import { modelStore } from "../../lib/use-model";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { HostDirectoryPicker } from "../node-palette/HostDirectoryPicker";
import { Button, Eyebrow } from "../ui";

const FILES_SIZE = { width: 280, height: 128 } as const;

const regionRootAt = (anchor: { readonly x: number; readonly y: number }): string | undefined =>
  resolveRegionCwd(
    modelStore.canvasOf(state$.canvasName.peek()),
    anchor.x + FILES_SIZE.width / 2,
    anchor.y + FILES_SIZE.height / 2,
    thisMachineName(),
  );

/** A Files node on this machine over `root`. Nothing is made while the files feature is off. */
export const createFilesAt = (
  anchor: { readonly x: number; readonly y: number },
  root: string,
): boolean => {
  const path = root.trim();
  if (!isAbsoluteFolder(path) || !featureOnNow("files")) return false;
  const node = newFiles(
    { ...anchor, z: topZ(modelStore.canvasOf(state$.canvasName.peek())) },
    { host: thisMachineName(), root: path },
    state$.settings.advanced.experimental.peek(),
  );
  addNode(node, { edit: false });
  state$.focusNodeId.set(node.id);
  return true;
};

/** Stamp the containing region's folder on this machine when one exists; it is never read again. */
export const createFilesFromRegion = (
  anchor: { readonly x: number; readonly y: number },
): boolean => {
  const root = regionRootAt(anchor);
  return root !== undefined && createFilesAt(anchor, root);
};

export function FilesWizard({
  anchor,
  onClose,
}: {
  readonly anchor: { x: number; y: number };
  readonly onClose: () => void;
}) {
  const seed = regionRootAt(anchor) ?? "";
  const [root, setRoot] = useState(seed);

  const create = () => {
    if (createFilesAt(anchor, root)) onClose();
  };

  return (
    <FocusSurface measure="form" height="fit" label="New files" onClose={onClose}>
      <div
        className="grid gap-4 p-5"
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
        }}
      >
        <div>
          <Eyebrow tone="steel">files - create</Eyebrow>
          <div className="mt-1 font-mono text-title font-semibold text-ink">New files</div>
        </div>
        <HostDirectoryPicker
          hostId={thisMachineName()}
          initialPath={seed || "~"}
          resetKey={seed || "~"}
          inputAriaLabel="Files folder"
          onSelect={setRoot}
          onDraftChange={setRoot}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="subtle" onClick={onClose}>
            cancel
          </Button>
          <Button size="sm" variant="primary" onClick={create} disabled={!isAbsoluteFolder(root)}>
            Create files
          </Button>
        </div>
      </div>
    </FocusSurface>
  );
}
