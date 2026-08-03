import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { stripEmptyRegionPaths } from "@shared/region-defaults";
import { trimTrailingSlash } from "../lib/directory-picker";
import { setRegionDefaults } from "../lib/mutations";
import { state$ } from "../lib/state";
import { getVellumApi } from "../lib/vellum-api";
import { FocusSurface } from "./FocusSurface";
import { HostDirectoryPicker } from "./node-palette/HostDirectoryPicker";
import { Button, IconButton, OverlayHeader } from "./ui";
import "./RegionPathsModal.css";

type HostOpt = { readonly id: string; readonly label: string };

const sortHosts = (opts: HostOpt[]): HostOpt[] =>
  [...opts].sort((a, b) => {
    if (a.id === LOCAL_HOST_ID) return -1;
    if (b.id === LOCAL_HOST_ID) return 1;
    return a.label.localeCompare(b.label);
  });

const labelForHost = (
  id: string,
  enrolled: ReadonlyArray<HostOpt>,
): string => enrolled.find((h) => h.id === id)?.label ?? id;

/**
 * Region host→cwd editor.
 * Left: host list + add. Right: filesystem for the selected host.
 */
export function RegionPathsModal({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const node = use$(() => state$.doc.nodes.get().find((n) => n.id === nodeId));
  const storedPaths =
    node?.type === "group" ? node.ether?.region?.defaults?.paths : undefined;
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

  const [enrolled, setEnrolled] = useState<HostOpt[]>([
    { id: LOCAL_HOST_ID, label: "this machine" },
  ]);
  /** Draft path by host id. */
  const [pathsByHost, setPathsByHost] = useState<Record<string, string>>(() => ({
    ...(storedPaths ?? {}),
  }));
  /** Hosts present in the sidebar (order preserved). */
  const [hostIds, setHostIds] = useState<string[]>(() => {
    const ids = Object.keys(storedPaths ?? {});
    return ids.length > 0 ? ids : [LOCAL_HOST_ID];
  });
  const [selectedHostId, setSelectedHostId] = useState<string>(
    () => Object.keys(storedPaths ?? {})[0] ?? LOCAL_HOST_ID,
  );

  useEffect(() => {
    const next = { ...(storedPaths ?? {}) };
    const ids = Object.keys(next);
    setPathsByHost(next);
    setHostIds(ids.length > 0 ? ids : [LOCAL_HOST_ID]);
    setSelectedHostId(ids[0] ?? LOCAL_HOST_ID);
  }, [nodeId, pathsFingerprint]);

  useEffect(() => {
    const api = getVellumApi();
    void api
      ?.hostsList?.()
      .then((res) => {
        if (!res?.ok || !Array.isArray(res.hosts)) return;
        const opts = res.hosts
          .filter((h) => typeof h.id === "string" && h.id.length > 0)
          .map((h) => ({
            id: h.id,
            label:
              h.label?.trim() ||
              (h.id === LOCAL_HOST_ID ? "this machine" : h.id),
          }));
        const seen = new Set<string>();
        const merged: HostOpt[] = [];
        for (const opt of opts) {
          if (seen.has(opt.id)) continue;
          seen.add(opt.id);
          merged.push(opt);
        }
        if (merged.length === 0) {
          merged.push({ id: LOCAL_HOST_ID, label: "this machine" });
        }
        for (const id of Object.keys(storedPaths ?? {})) {
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push({ id, label: id });
        }
        setEnrolled(sortHosts(merged));
      })
      .catch(() => undefined);
  }, [nodeId, pathsFingerprint]);

  if (!node || node.type !== "group") return null;

  const unusedHosts = enrolled.filter((h) => !hostIds.includes(h.id));
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
      const remaining = next.length > 0 ? next : [LOCAL_HOST_ID];
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
    const current = node.ether?.region?.defaults;
    const next = {
      ...(current?.herdr ? { herdr: current.herdr } : {}),
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
      layer="detail"
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

        <div className="region-paths__body">
          <aside className="region-paths__sidebar" aria-label="Hosts">
            <ul className="region-paths__host-list" role="listbox" aria-label="Hosts with paths">
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
                        {labelForHost(hostId, enrolled)}
                      </span>
                      <span className="region-paths__host-path">
                        {hasPath ? path : "no path"}
                      </span>
                    </button>
                    <IconButton
                      tone="danger"
                      size="sm"
                      className="region-paths__host-remove"
                      aria-label={`Remove ${labelForHost(hostId, enrolled)}`}
                      title="Remove host"
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
              add host
            </Button>
          </aside>

          <section className="region-paths__main" aria-label="Directory">
            <div className="region-paths__main-label">
              {labelForHost(selectedHostId, enrolled)}
            </div>
            <div className="region-paths__picker">
              <HostDirectoryPicker
                key={selectedHostId}
                hostId={selectedHostId || LOCAL_HOST_ID}
                initialPath={selectedPath.trim() || "~"}
                resetKey={`${selectedHostId}\0${pathsFingerprint}`}
                inputAriaLabel={`Working directory for ${labelForHost(selectedHostId, enrolled)}`}
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
