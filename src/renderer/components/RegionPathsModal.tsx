import { useEffect, useId, useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { stripEmptyRegionPaths } from "@shared/region-defaults";
import { setRegionDefaults } from "../lib/mutations";
import { state$ } from "../lib/state";
import { getVellumApi } from "../lib/vellum-api";
import { FocusSurface } from "./FocusSurface";
import { Button, FieldLabel, IconButton, Input, OverlayHeader, Select } from "./ui";

type HostOpt = { readonly id: string; readonly label: string };
type PathRow = { readonly key: string; host: string; path: string };

let rowSeq = 0;
const nextRowKey = (): string => {
  rowSeq += 1;
  return `path-row-${rowSeq}`;
};

const rowsFromPaths = (
  paths: Readonly<Record<string, string>> | undefined,
): PathRow[] => {
  if (!paths) return [];
  return Object.entries(paths)
    .filter(([host, path]) => host.trim() && path.trim())
    .map(([host, path]) => ({ key: nextRowKey(), host, path }));
};

const sortHosts = (opts: HostOpt[]): HostOpt[] =>
  [...opts].sort((a, b) => {
    if (a.id === LOCAL_HOST_ID) return -1;
    if (b.id === LOCAL_HOST_ID) return 1;
    return a.label.localeCompare(b.label);
  });

/**
 * Region host→cwd map editor. Create-time stamp source only — agents and
 * terminals placed inside the region inherit the path for their host.
 *
 * Surface chrome: FocusSurface form measure + OverlayHeader (same instrument
 * as work-ledger / fleet overlays). Fields: Input / Select / FieldLabel /
 * Button / IconButton — no hand-rolled controls.
 */
export function RegionPathsModal({
  nodeId,
  onClose,
}: {
  readonly nodeId: string;
  readonly onClose: () => void;
}) {
  const listId = useId();
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
  const regionLabel =
    node?.type === "group" ? (node.label?.trim() || "unnamed region") : "region";

  const [hostOptions, setHostOptions] = useState<HostOpt[]>([
    { id: LOCAL_HOST_ID, label: "this machine" },
  ]);
  const [rows, setRows] = useState<PathRow[]>(() => rowsFromPaths(storedPaths));

  useEffect(() => {
    setRows(rowsFromPaths(storedPaths));
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
              h.kind === "remote"
                ? `${h.label || h.id} (remote)`
                : h.label || (h.id === LOCAL_HOST_ID ? "this machine" : h.id),
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
        // Keep hosts already stored on the region even if de-enrolled.
        for (const row of rowsFromPaths(storedPaths)) {
          if (seen.has(row.host)) continue;
          seen.add(row.host);
          merged.push({ id: row.host, label: row.host });
        }
        setHostOptions(sortHosts(merged));
      })
      .catch(() => undefined);
  }, [nodeId, pathsFingerprint]);

  const hostSelectOptions = useMemo(
    () => hostOptions.map((h) => ({ value: h.id, label: h.label })),
    [hostOptions],
  );

  if (!node || node.type !== "group") return null;

  const updateRow = (key: string, patch: Partial<Pick<PathRow, "host" | "path">>) => {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  const removeRow = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
  };

  const addRow = () => {
    const used = new Set(rows.map((r) => r.host.trim()).filter(Boolean));
    const free =
      hostOptions.find((h) => !used.has(h.id))?.id ??
      hostOptions[0]?.id ??
      LOCAL_HOST_ID;
    setRows((current) => [...current, { key: nextRowKey(), host: free, path: "" }]);
  };

  const save = () => {
    const map: Record<string, string> = {};
    for (const row of rows) {
      const host = row.host.trim();
      const path = row.path.trim();
      if (!host || !path) continue;
      map[host] = path;
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
      measure="form"
      height="fit"
      layer="detail"
      label="Region folder paths"
      onClose={onClose}
      panelClassName="region-paths-modal"
    >
      <OverlayHeader
        eyebrow="region · paths"
        title="Folder paths"
        status={`${regionLabel} · per-host cwd for agents & terminals`}
        actions={
          <IconButton aria-label="Close folder paths" title="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      />

      <form
        className="grid gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <p className="m-0 text-[11px] leading-relaxed text-dim">
          Create-time only. Place an agent or terminal inside this region and it
          stamps <span className="font-mono text-ink">launch.cwd</span> for that
          host. Edit a seat after create to override.
        </p>

        <div
          id={listId}
          role="list"
          aria-label="Host folder paths"
          className="grid gap-3"
        >
          {rows.length === 0 ? (
            <div
              role="status"
              className="rounded-[5px] border border-stroke bg-inset px-3 py-3 text-[11px] leading-relaxed text-dim"
            >
              No host paths yet. Add one so agents and terminals spawn in the
              right folder on each machine.
            </div>
          ) : (
            rows.map((row, index) => {
              const hostLabel = `Host for path ${index + 1}`;
              const pathLabel = `Default path for ${row.host || `path ${index + 1}`}`;
              return (
                <div
                  key={row.key}
                  role="listitem"
                  className="grid gap-2 rounded-[5px] border border-stroke/80 bg-raise/40 p-2.5"
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                    <FieldLabel>
                      Host
                      <Select
                        aria-label={hostLabel}
                        value={row.host}
                        options={
                          hostSelectOptions.some((o) => o.value === row.host)
                            ? hostSelectOptions
                            : [{ value: row.host, label: row.host }, ...hostSelectOptions]
                        }
                        onChange={(value) => updateRow(row.key, { host: value })}
                      />
                    </FieldLabel>
                    <IconButton
                      tone="danger"
                      size="md"
                      className="mb-0.5"
                      aria-label={`Remove path for ${row.host || `row ${index + 1}`}`}
                      title="Remove path"
                      onClick={() => removeRow(row.key)}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                  <FieldLabel>
                    Default path
                    <Input
                      aria-label={pathLabel}
                      value={row.path}
                      placeholder="/Users/you/Projects/app"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => updateRow(row.key, { path: e.target.value })}
                    />
                  </FieldLabel>
                </div>
              );
            })
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" size="sm" variant="chrome" onClick={addRow}>
            <Plus size={14} aria-hidden />
            add host
          </Button>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="subtle" onClick={onClose}>
              cancel
            </Button>
            <Button type="submit" size="sm" variant="primary">
              save
            </Button>
          </div>
        </div>
      </form>
    </FocusSurface>
  );
}
