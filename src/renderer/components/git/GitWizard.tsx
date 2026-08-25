import { useState } from "react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { resolveRegionCwd } from "@shared/region-defaults";
import { makeGitNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { HostDirectoryPicker } from "../node-palette/HostDirectoryPicker";
import { Button, Eyebrow } from "../ui";

const GIT_SIZE = { width: 280, height: 128 } as const;

const regionCwdAt = (anchor: { readonly x: number; readonly y: number }): string | undefined =>
  resolveRegionCwd(
    state$.doc.peek(),
    anchor.x + GIT_SIZE.width / 2,
    anchor.y + GIT_SIZE.height / 2,
    LOCAL_HOST_ID,
  );

export const createGitAt = (
  anchor: { readonly x: number; readonly y: number },
  cwd: string,
): void => {
  const path = cwd.trim();
  if (!path) return;
  const node = makeGitNode(anchor.x, anchor.y, path);
  addNode(node, { edit: false });
  state$.focusNodeId.set(node.id);
};

/** Stamp from the containing region's host path when one exists. */
export const createGitFromRegion = (
  anchor: { readonly x: number; readonly y: number },
): boolean => {
  const cwd = regionCwdAt(anchor);
  if (!cwd) return false;
  createGitAt(anchor, cwd);
  return true;
};

export function GitWizard({
  anchor,
  onClose,
}: {
  readonly anchor: { x: number; y: number };
  readonly onClose: () => void;
}) {
  const seed = regionCwdAt(anchor) ?? "";
  const [cwd, setCwd] = useState(seed);

  const create = () => {
    if (!cwd.trim()) return;
    createGitAt(anchor, cwd);
    onClose();
  };

  return (
    <FocusSurface measure="form" height="fit" layer="detail" label="New git" onClose={onClose}>
      <div
        className="grid gap-4 p-5"
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
        }}
      >
        <div>
          <Eyebrow tone="steel">git - create</Eyebrow>
          <div className="mt-1 font-mono text-[16px] font-semibold text-ink">New git</div>
        </div>
        <HostDirectoryPicker
          hostId={LOCAL_HOST_ID}
          initialPath={seed || "~"}
          resetKey={seed || "~"}
          inputAriaLabel="Git repository folder"
          onSelect={setCwd}
          onDraftChange={setCwd}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="subtle" onClick={onClose}>
            cancel
          </Button>
          <Button size="sm" variant="primary" onClick={create} disabled={!cwd.trim()}>
            Create git
          </Button>
        </div>
      </div>
    </FocusSurface>
  );
}
