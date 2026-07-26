import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { stripEmptyRegionPaths } from "@shared/region-defaults";
import { setRegionDefaults } from "../lib/mutations";
import { state$ } from "../lib/state";
import { getVellumApi } from "../lib/vellum-api";
import { FocusSurface } from "./FocusSurface";
import { Button, Eyebrow, FieldLabel, Input, Select } from "./ui";

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

/**
 * Region host→cwd map editor. Create-time stamp source only — agents and
 * terminals placed inside the region inherit the path for their host.
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
  const regionLabel =
    node?.type === "group" ? (node.label?.trim() || "unnamed region") : "region";

  const [hostOptions, setHostOptions] = useState<HostOpt[]>([
    { id: LOCAL_HOST_ID, label: "this machine" },
  ]);
  const [rows, setRows] = useState<PathRow[]>(() => rowsFromPaths(storedPaths));

  useEffect(() => {
    setRows(rowsFromPaths(storedPaths));
  }, [nodeId, storedPaths]);

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
        merged.sort((a, b) => {
          if (a.id === LOCAL_HOST_ID) return -1;
          if (b.id === LOCAL_HOST_ID) return 1;
          return a.label.localeCompare(b.label);
        });
        setHostOptions(merged);
      })
      .catch(() => undefined);
  }, [nodeId, storedPaths]);

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
    <FocusSurface measure="form" height="fit" layer="detail" label="Region folder paths" onClose={onClose}>
      <div className="grid gap-4 p-5">
        <div>
          <Eyebrow tone="steel">region · paths</Eyebrow>
          <div className="mt-1 font-mono text-[16px] font-semibold text-ink">Folder paths</div>
          <p className="mt-1 text-[11px] leading-relaxed text-dim">
            Agents and terminals created inside <span className="text-ink">{regionLabel}</span>{" "}
            spawn under the path for their host. Create-time only — edit a seat after create to override.
          </p>
        </div>

        <div className="grid gap-2">
          {rows.length === 0 ? (
            <div className="rounded-[6px] border border-stroke bg-inset px-3 py-3 text-[11px] text-faint">
              No host paths yet. Add one so actors spawn in the right folder.
            </div>
          ) : (
            rows.map((row) => (
              <div key={row.key} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_auto] items-end gap-2">
                <FieldLabel>
                  Host
                  <Select
                    aria-label={`Path host for row`}
                    value={row.host}
                    options={
                      hostSelectOptions.some((o) => o.value === row.host)
                        ? hostSelectOptions
                        : [{ value: row.host, label: row.host }, ...hostSelectOptions]
                    }
                    onChange={(value) => updateRow(row.key, { host: value })}
                  />
                </FieldLabel>
                <FieldLabel>
                  Default path
                  <Input
                    aria-label={`Default path for ${row.host || "host"}`}
                    value={row.path}
                    placeholder="/Users/you/Projects/app"
                    onChange={(e) => updateRow(row.key, { path: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        save();
                      }
                    }}
                  />
                </FieldLabel>
                <Button
                  size="sm"
                  variant="subtle"
                  aria-label="Remove path row"
                  onClick={() => removeRow(row.key)}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button size="sm" variant="subtle" onClick={addRow}>
            <Plus size={14} />
            add host
          </Button>
          <div className="flex gap-2">
            <Button size="sm" variant="subtle" onClick={onClose}>
              cancel
            </Button>
            <Button size="sm" variant="primary" onClick={save}>
              save
            </Button>
          </div>
        </div>
      </div>
    </FocusSurface>
  );
}
