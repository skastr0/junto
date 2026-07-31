import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, FolderOpen, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { findContainingRegion, resolveRegionCwd, stripEmptyRegionPaths } from "@shared/region-defaults";
import type { EtherRegionDefaults } from "@shared/canvas";
import { state$ } from "../../lib/state";
import { setRegionDefaults } from "../../lib/mutations";
import { getVellumApi } from "../../lib/vellum-api";
import {
  actorHostChoicesFromEnrollment,
  type AgentHostChoice,
} from "../terminal/AgentCascadeMenu";
import { HostDirectoryPicker } from "../terminal/HostDirectoryPicker";
import { Button, IconButton, Select } from "../ui";

const AGENT_SIZE = { width: 260, height: 110 } as const;

export type AgentLaunchContextValue = {
  readonly host: string;
  readonly agentHost: string;
  readonly cwd: string;
  /** Innermost region under the pending agent, when there is one. */
  readonly regionId?: string;
  readonly useRegionDefault: boolean;
};

export type AgentLaunchContextProps = {
  /** Top-left canvas coordinate for the pending agent. */
  readonly position: { readonly x: number; readonly y: number };
  /** Called whenever the choices ready for the next agent change. */
  readonly onChange: (value: AgentLaunchContextValue) => void;
  readonly initialHostId?: string;
  readonly className?: string;
};

const configuredHost = (): AgentHostChoice => {
  const hostId = state$.settings.station.hostId.peek() || LOCAL_HOST_ID;
  return {
    id: hostId,
    agentHost: state$.settings.station.agentHostId.peek() || hostId,
    label: hostId === LOCAL_HOST_ID ? "this machine" : hostId,
  };
};

const centerOf = (position: AgentLaunchContextProps["position"]) => ({
  x: position.x + AGENT_SIZE.width / 2,
  y: position.y + AGENT_SIZE.height / 2,
});

const savePathAsRegionDefault = (
  regionId: string,
  defaults: EtherRegionDefaults | undefined,
  host: string,
  path: string | undefined,
) => {
  const existing = defaults?.paths ?? {};
  const paths = { ...existing } as Record<string, string>;
  if (path?.trim()) paths[host] = path.trim();
  else delete paths[host];
  const cleanedPaths = stripEmptyRegionPaths(paths);
  const next: EtherRegionDefaults = {
    ...(defaults?.herdr ? { herdr: defaults.herdr } : {}),
    ...(defaults?.page ? { page: defaults.page } : {}),
    ...(cleanedPaths ? { paths: cleanedPaths } : {}),
  };
  setRegionDefaults(regionId, Object.keys(next).length > 0 ? next : undefined);
};

/**
 * Persistent launch settings for the next agent in the palette. Folder browsing
 * stays deliberately small: the existing host-aware tree only opens on demand.
 */
export function AgentLaunchContext({
  position,
  onChange,
  initialHostId,
  className,
}: AgentLaunchContextProps) {
  const doc = use$(() => state$.doc.get());
  const anchorRef = useRef<HTMLDivElement>(null);
  const configured = useMemo(configuredHost, []);
  const [hosts, setHosts] = useState<ReadonlyArray<AgentHostChoice>>([configured]);
  const [hostId, setHostId] = useState(initialHostId || configured.id);
  const [cwd, setCwd] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);

  const center = centerOf(position);
  const region = useMemo(
    () => findContainingRegion(doc, center.x, center.y),
    [center.x, center.y, doc],
  );
  const regionPath = resolveRegionCwd(doc, center.x, center.y, hostId);
  const selectedHost = hosts.find((host) => host.id === hostId) ?? configured;
  const regionDefaultPath = region?.ether?.region?.defaults?.paths?.[hostId]?.trim();
  const [useRegionDefault, setUseRegionDefault] = useState(Boolean(regionDefaultPath));

  useEffect(() => {
    let live = true;
    void getVellumApi()?.hostsList?.().then((result) => {
      if (!live || !result.ok || !result.hosts) return;
      const next = actorHostChoicesFromEnrollment(result.hosts, configured);
      setHosts(next);
      setHostId((current) =>
        next.some((host) => host.id === current) ? current : configured.id,
      );
    }).catch(() => undefined);
    return () => { live = false; };
  }, [configured]);

  // A new placement or host starts from the innermost region's per-host path.
  useEffect(() => {
    setCwd(regionPath ?? "");
    setUseRegionDefault(Boolean(regionDefaultPath));
  }, [hostId, region?.id, regionPath, regionDefaultPath]);

  useEffect(() => {
    onChange({
      host: selectedHost.id,
      agentHost: selectedHost.agentHost,
      cwd,
      ...(region ? { regionId: region.id } : {}),
      useRegionDefault,
    });
  }, [cwd, onChange, region, selectedHost.agentHost, selectedHost.id, useRegionDefault]);

  useEffect(() => {
    if (!folderOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFolderOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [folderOpen]);

  const selectHost = (nextHostId: string) => {
    setHostId(nextHostId);
    setFolderOpen(false);
  };

  const toggleRegionDefault = (checked: boolean) => {
    if (!region) return;
    setUseRegionDefault(checked);
    savePathAsRegionDefault(
      region.id,
      region.ether?.region?.defaults,
      hostId,
      checked ? cwd : undefined,
    );
  };

  const saveSelectedFolder = (path: string) => {
    setCwd(path);
    if (useRegionDefault && region) {
      savePathAsRegionDefault(
        region.id,
        region.ether?.region?.defaults,
        hostId,
        path,
      );
    }
  };

  const popover = folderOpen && anchorRef.current
    ? (() => {
        const rect = anchorRef.current!.getBoundingClientRect();
        return createPortal(
          <div
            role="dialog"
            aria-label="Choose starting folder"
            className="fixed z-[80] w-[min(420px,calc(100vw-24px))] rounded-[7px] border border-stroke bg-ground p-3 shadow-[0_18px_42px_rgba(0,0,0,.48)]"
            style={{ left: Math.max(12, Math.min(rect.left, window.innerWidth - 432)), bottom: window.innerHeight - rect.top + 8 }}
          >
            <div className="mb-3 flex items-center justify-between border-b border-stroke pb-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink">
                <FolderOpen size={14} className="text-cyan" />
                Choose starting folder
              </div>
              <IconButton aria-label="Close folder picker" title="Close" onClick={() => setFolderOpen(false)}>
                <X size={14} />
              </IconButton>
            </div>
            <HostDirectoryPicker
              key={`${hostId}\0${cwd || regionPath || "~"}`}
              hostId={hostId}
              initialPath={cwd || regionPath || "~"}
              onSelect={saveSelectedFolder}
            />
            <label
              title={region ? undefined : "Add a region to set up defaults and shared context"}
              className={[
                "mt-3 flex cursor-pointer items-start gap-2 border-t border-stroke pt-3 text-[11px] leading-snug text-dim",
                region ? "" : "cursor-not-allowed opacity-55",
              ].join(" ")}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={useRegionDefault}
                disabled={!region || !cwd}
                onChange={(event) => toggleRegionDefault(event.target.checked)}
              />
              <span
                aria-hidden="true"
                className={[
                  "mt-px grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border",
                  useRegionDefault && region ? "border-amber bg-amber/15 text-amber" : "border-stroke bg-inset text-transparent",
                ].join(" ")}
              >
                <Check size={11} strokeWidth={2.6} />
              </span>
              <span>
                <span className="block text-ink">Use this folder as region default for this host</span>
                {!region ? <span className="block pt-0.5 text-[10px]">Add a region to set up defaults and shared context</span> : null}
              </span>
            </label>
          </div>,
          document.body,
        );
      })()
    : null;

  return (
    <section
      className={["grid gap-3 border-t border-stroke bg-well/40 px-3 py-3", className].filter(Boolean).join(" ")}
      role="region"
      aria-label="Launch context"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink">Launch context</span>
        <span className="text-[10px] text-dim">applies to next agent</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-2">
        <label className="grid gap-1 text-[10px] uppercase tracking-[0.1em] text-dim">
          Agent host
          <Select
            aria-label="Agent host"
            value={hostId}
            options={hosts.map((host) => ({ value: host.id, label: host.label }))}
            onChange={selectHost}
          />
        </label>
        <label className="grid gap-1 text-[10px] uppercase tracking-[0.1em] text-dim">
          Agent working directory
          <div ref={anchorRef} className="relative flex min-w-0">
            <Button
              type="button"
              variant="chrome"
              size="sm"
              className="min-w-0 flex-1 justify-between normal-case tracking-normal"
              aria-haspopup="dialog"
              aria-expanded={folderOpen}
              aria-label="Choose starting folder"
              onClick={() => setFolderOpen((open) => !open)}
            >
              <span className="min-w-0 truncate font-mono text-[11px]">{cwd || "choose folder"}</span>
              <ChevronDown size={13} className="shrink-0" />
            </Button>
          </div>
        </label>
      </div>
      {popover}
    </section>
  );
}
