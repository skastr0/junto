import { useEffect, useState } from "react";
import { FILES_REMOTE_ENABLED } from "@shared/features";
import { resolveRegionCwd } from "@shared/region-defaults";
import { featureOnNow } from "../../lib/experimental-features";
import { isAbsoluteFolder, newFiles } from "../../lib/model-factories";
import { topZ } from "../../lib/model-edits";
import { thisMachineName, useFilesMachineChoices, useThisMachineName } from "../../lib/machines";
import { addNode } from "../../lib/mutations";
import { modelStore } from "../../lib/use-model";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { HostDirectoryPicker } from "../node-palette/HostDirectoryPicker";
import { Button, Eyebrow, FieldLabel, Input, Select } from "../ui";

const FILES_SIZE = { width: 280, height: 128 } as const;

const regionRootAt = (
  anchor: { readonly x: number; readonly y: number },
  host = thisMachineName(),
): string | undefined =>
  resolveRegionCwd(
    modelStore.canvasOf(state$.canvasName.peek()),
    anchor.x + FILES_SIZE.width / 2,
    anchor.y + FILES_SIZE.height / 2,
    host,
  );

/** A Files node over `root` on `host`. Nothing is made while the files feature is off. */
export const createFilesAt = (
  anchor: { readonly x: number; readonly y: number },
  host: string,
  root: string,
): boolean => {
  const path = root.trim();
  if (!host.trim() || !isAbsoluteFolder(path) || !featureOnNow("files")) return false;
  const node = newFiles(
    { ...anchor, z: topZ(modelStore.canvasOf(state$.canvasName.peek())) },
    { host: host.trim(), root: path },
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
  return root !== undefined && createFilesAt(anchor, thisMachineName(), root);
};

export function FilesWizard({
  anchor,
  onClose,
}: {
  readonly anchor: { x: number; y: number };
  readonly onClose: () => void;
}) {
  const thisName = useThisMachineName();
  const remote = FILES_REMOTE_ENABLED;
  const choices = useFilesMachineChoices();
  const [machine, setMachine] = useState(thisName);
  const [root, setRoot] = useState(() => regionRootAt(anchor, thisName) ?? "");

  // Settings hydrate the machine's own name after the first paint.
  useEffect(() => {
    setMachine((current) => (current === "" ? thisName : current));
    if (thisName !== "") setRoot((current) => (current === "" ? (regionRootAt(anchor, thisName) ?? "") : current));
  }, [anchor, thisName]);

  // A machine that left the list cannot stay chosen; the choice falls back to this machine.
  useEffect(() => {
    if (!remote || choices.length === 0 || choices.some((choice) => choice.id === machine)) return;
    const next = choices[0]!.id;
    setMachine(next);
    setRoot(regionRootAt(anchor, next) ?? "");
  }, [anchor, choices, machine, remote]);

  const chooseMachine = (next: string) => {
    setMachine(next);
    setRoot(regionRootAt(anchor, next) ?? "");
  };

  const here = machine === thisName;
  const label = choices.find((choice) => choice.id === machine)?.label ?? machine;
  const seed = regionRootAt(anchor, machine) ?? "";
  const create = () => {
    if (createFilesAt(anchor, remote ? machine : thisName, root)) onClose();
  };

  const folderPicker = (
    <HostDirectoryPicker
      hostId={machine || thisName}
      initialPath={seed || "~"}
      resetKey={`${machine || thisName}\u0000${seed || "~"}`}
      inputAriaLabel="Files folder"
      onSelect={setRoot}
      onDraftChange={setRoot}
    />
  );

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
        {remote ? (
          <>
            <FieldLabel>
              Machine
              <Select
                aria-label="Machine"
                value={machine}
                options={choices.map((choice) => ({ value: choice.id, label: choice.label }))}
                onChange={chooseMachine}
              />
            </FieldLabel>
            <FieldLabel>
              Folder
              {here ? (
                folderPicker
              ) : (
                <>
                  <Input
                    aria-label="Files folder"
                    value={root}
                    onChange={(event) => setRoot(event.target.value)}
                    placeholder="/absolute/path"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <span className="text-label normal-case tracking-normal text-dim">
                    A folder path on {label}.
                  </span>
                </>
              )}
            </FieldLabel>
          </>
        ) : (
          folderPicker
        )}
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
