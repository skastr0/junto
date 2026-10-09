import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { FLEET_UI_ENABLED } from "@shared/features";
import { stripEmptyRegionPaths } from "@shared/region-defaults";
import { trimTrailingSlash } from "../lib/directory-picker";
import {
  loadMachines,
  machineChoices,
  machineLabelIn,
  useMachines,
  useSetUpMachines,
  useThisMachineName,
  type MachineChoice,
} from "../lib/machines";
import { setRegionDefaults } from "../lib/mutations";
import { state$ } from "../lib/state";
import { useNodeOf } from "../lib/use-model";
import { FocusSurface } from "./FocusSurface";
import { HostDirectoryPicker } from "./node-palette/HostDirectoryPicker";
import { Button, IconButton, OverlayHeader } from "./ui";
import "./RegionPathsModal.css";

const labelOf = (id: string, machines: ReadonlyArray<MachineChoice>): string =>
  machines.find((machine) => machine.id === id)?.label ?? id;

/**
 * A region's folder on each machine.
 * Left: the machines that have one, and add. Right: that machine's folders.
 */
export function RegionPathsModal({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const node = useNodeOf(use$(state$.canvasName), nodeId, "region");
  const thisMachine = useThisMachineName();
  const listed = useMachines();
  const setUp = useSetUpMachines();
  const storedPaths =
    node?.defaults?.paths;
  const pathsFingerprint = useMemo(
    () =>
      storedPaths
        ? Object.entries(storedPaths)
            .map(([h, p]) => `${h}\0${p}`)
            .sort()
            .join("\n")
        : "",
    [storedPaths],
  );

  /** Every machine that can be given a folder: the ones that are set up, and
      any a stored folder still names, which keeps the label it is listed by. */
  const machines = useMemo(() => {
    const known = machineChoices(setUp, thisMachine);
    const ids = new Set(known.map((machine) => machine.id));
    const stored = Object.keys(storedPaths ?? {})
      .filter((id) => !ids.has(id))
      .sort()
      .map((id) => ({ id, label: machineLabelIn(listed, id) }));
    return [...known, ...stored];
    // The fingerprint stands for the stored folders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listed, setUp, thisMachine, pathsFingerprint]);
  /** Draft folder by machine. */
  const [pathsByHost, setPathsByHost] = useState<Record<string, string>>(() => ({
    ...(storedPaths ?? {}),
  }));
  /** Machines in the sidebar (order preserved). Without the machines
      surface, this machine is always present and selected; folders stored for
      other machines ride along untouched so save never drops them. */
  const [hostIds, setHostIds] = useState<string[]>(() => {
    const ids = Object.keys(storedPaths ?? {});
    if (!FLEET_UI_ENABLED) {
      return ids.includes(thisMachine) ? ids : [...ids, thisMachine];
    }
    return ids.length > 0 ? ids : [thisMachine];
  });
  const [selectedHostId, setSelectedHostId] = useState<string>(() =>
    FLEET_UI_ENABLED
      ? Object.keys(storedPaths ?? {})[0] ?? thisMachine
      : thisMachine,
  );

  useEffect(() => {
    const next = { ...(storedPaths ?? {}) };
    const ids = Object.keys(next);
    setPathsByHost(next);
    if (!FLEET_UI_ENABLED) {
      setHostIds(ids.includes(thisMachine) ? ids : [...ids, thisMachine]);
      setSelectedHostId(thisMachine);
      return;
    }
    setHostIds(ids.length > 0 ? ids : [thisMachine]);
    setSelectedHostId(ids[0] ?? thisMachine);
  }, [nodeId, pathsFingerprint, thisMachine]);

  useEffect(() => {
    if (FLEET_UI_ENABLED) void loadMachines();
  }, [nodeId]);

  // A folder is kept by machine name, so nothing can be edited before this
  // machine's name is known.
  if (!node || !thisMachine) return null;

  const unusedHosts = machines.filter((h) => !hostIds.includes(h.id));
  const selectedPath = pathsByHost[selectedHostId] ?? "";

  const addHost = () => {
    const next = unusedHosts[0];
    if (!next) return;
    setHostIds((ids) => [...ids, next.id]);
    setPathsByHost((map) => ({ ...map, [next.id]: map[next.id] ?? "" }));
    setSelectedHostId(next.id);
  };

  const removeHost = (hostId: string) => {
    setHostIds((ids) => {
      const next = ids.filter((id) => id !== hostId);
      const remaining = next.length > 0 ? next : [thisMachine];
      setSelectedHostId((current) => (current === hostId ? remaining[0]! : current));
      return remaining;
    });
    setPathsByHost((map) => {
      const { [hostId]: _drop, ...rest } = map;
      return rest;
    });
  };

  const setPath = (hostId: string, path: string) => {
    setPathsByHost((map) => ({ ...map, [hostId]: path }));
  };

  const save = () => {
    const map: Record<string, string> = {};
    for (const hostId of hostIds) {
      const path = trimTrailingSlash((pathsByHost[hostId] ?? "").trim());
      if (!hostId || !path || path === "~") continue;
      map[hostId] = path;
    }
    const paths = stripEmptyRegionPaths(map);
    const current = node.defaults;
    const next = {
      ...(current?.page ? { page: current.page } : {}),
      ...(paths ? { paths } : {}),
    };
    setRegionDefaults(nodeId, Object.keys(next).length > 0 ? next : undefined);
    onClose();
  };

  return (
    <FocusSurface
      measure="document"
      height="fit"
      label="Region folder paths"
      onClose={onClose}
    >
      <div className="region-paths">
        <OverlayHeader
          eyebrow="region"
          title="Folder paths"
          actions={
            <IconButton aria-label="Close folder paths" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          }
        />

        <div
          className={`region-paths__body${FLEET_UI_ENABLED ? "" : " region-paths__body--single"}`}
        >
          {FLEET_UI_ENABLED ? (
          <aside className="region-paths__sidebar" aria-label="Machines">
            <ul className="region-paths__host-list" role="listbox" aria-label="Machines with a folder">
              {hostIds.map((hostId) => {
                const active = hostId === selectedHostId;
                const path = (pathsByHost[hostId] ?? "").trim();
                const hasPath = Boolean(path && path !== "~");
                return (
                  <li key={hostId} className="region-paths__host-item">
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`region-paths__host-btn${active ? " is-active" : ""}`}
                      onClick={() => setSelectedHostId(hostId)}
                    >
                      <span className="region-paths__host-name">
                        {labelOf(hostId, machines)}
                      </span>
                      <span className="region-paths__host-path">
                        {hasPath ? path : "no path"}
                      </span>
                    </button>
                    <IconButton
                      tone="danger"
                      size="sm"
                      className="region-paths__host-remove"
                      aria-label={`Remove ${labelOf(hostId, machines)}`}
                      title="Remove machine"
                      onClick={() => removeHost(hostId)}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
            <Button
              type="button"
              size="sm"
              variant="chrome"
              className="region-paths__add"
              disabled={unusedHosts.length === 0}
              onClick={addHost}
            >
              <Plus size={14} aria-hidden />
              add machine
            </Button>
          </aside>
          ) : null}

          <section className="region-paths__main" aria-label="Directory">
            {FLEET_UI_ENABLED ? (
              <div className="region-paths__main-label">
                {labelOf(selectedHostId, machines)}
              </div>
            ) : null}
            <div className="region-paths__picker">
              <HostDirectoryPicker
                key={selectedHostId}
                hostId={selectedHostId || thisMachine}
                initialPath={selectedPath.trim() || "~"}
                resetKey={`${selectedHostId}\0${pathsFingerprint}`}
                inputAriaLabel={`Working directory for ${labelOf(selectedHostId, machines)}`}
                onSelect={(path) => setPath(selectedHostId, path)}
                onDraftChange={(draft) => setPath(selectedHostId, draft)}
              />
            </div>
          </section>
        </div>

        <footer className="region-paths__footer">
          <Button type="button" size="sm" variant="subtle" onClick={onClose}>
            cancel
          </Button>
          <Button type="button" size="sm" variant="primary" onClick={save}>
            save
          </Button>
        </footer>
      </div>
    </FocusSurface>
  );
}
