import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FolderOpen, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { LOCAL_HOST_ID } from "@shared/remote-hosts";
import { FLEET_UI_ENABLED, HERMES_INTEGRATION_ENABLED } from "@shared/features";
import { findContainingRegion, resolveRegionCwd } from "@shared/region-defaults";
import { state$ } from "../../lib/state";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { AGENT_NODE_SIZE } from "../../lib/node-geometry";
import {
  actorHostChoicesFromEnrollment,
  type AgentHostChoice,
} from "./agent-launch-model";
import { HostDirectoryPicker } from "./HostDirectoryPicker";
import { Button, IconButton, Select } from "../ui";
import {
  RegionDefaultFolderOption,
  savePathAsRegionDefault,
} from "./RegionDefaultFolderOption";

export type AgentLaunchContextValue = {
  readonly host: string;
  readonly agentHost: string;
  readonly cwd: string;
};

export const defaultAgentLaunchContext = (): AgentLaunchContextValue => {
  const host = state$.settings.station.hostId.peek() || LOCAL_HOST_ID;
  return {
    host,
    agentHost: HERMES_INTEGRATION_ENABLED
      ? state$.settings.station.agentHostId.peek() || host
      : host,
    cwd: "",
  };
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
  const context = defaultAgentLaunchContext();
  return {
    id: context.host,
    agentHost: context.agentHost,
    label: context.host === LOCAL_HOST_ID ? "this machine" : context.host,
  };
};

const centerOf = (position: AgentLaunchContextProps["position"]) => ({
  x: position.x + AGENT_NODE_SIZE.width / 2,
  y: position.y + AGENT_NODE_SIZE.height / 2,
});

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
  const [hostId, setHostId] = useState(
    FLEET_UI_ENABLED ? initialHostId || configured.id : configured.id,
  );
  const center = centerOf(position);
  const region = useMemo(
    () => findContainingRegion(doc, center.x, center.y),
    [center.x, center.y, doc],
  );
  const regionPath = resolveRegionCwd(doc, center.x, center.y, hostId);
  const selectedHost = hosts.find((host) => host.id === hostId) ?? configured;
  const regionDefaultPath = region?.ether?.region?.defaults?.paths?.[hostId]?.trim();
  const [useRegionDefault, setUseRegionDefault] = useState(Boolean(regionDefaultPath));
  const [cwd, setCwd] = useState(() => regionPath ?? "");
  const [folderSeed, setFolderSeed] = useState(() => regionPath ?? "~");
  const [folderOpen, setFolderOpen] = useState(false);

  useEffect(() => {
    if (!FLEET_UI_ENABLED) return;
    let live = true;
    void getVellumCommandApi()?.hostsList?.().then((result) => {
      if (!live || !result.ok || !result.hosts) return;
      const next = actorHostChoicesFromEnrollment(result.hosts, configured);
      setHosts(next);
      setHostId((current) =>
        next.some((host) => host.id === current) ? current : configured.id,
      );
    }).catch(() => undefined);
    return () => { live = false; };
  }, [configured]);

  // Seed only when placement identity changes. Saving a default mutates `doc`;
  // that mutation must not reset the checkbox state that initiated it.
  useEffect(() => {
    const nextPath = resolveRegionCwd(doc, center.x, center.y, hostId);
    const nextDefault = region?.ether?.region?.defaults?.paths?.[hostId]?.trim();
    setCwd(nextPath ?? "");
    setFolderSeed(nextPath ?? "~");
    setUseRegionDefault(Boolean(nextDefault));
    // `doc` changes when this control writes a default; placement identity is
    // the intentional reset boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, region?.id]);

  useEffect(() => {
    onChange({
      host: selectedHost.id,
      agentHost: selectedHost.agentHost,
      cwd,
    });
  }, [cwd, onChange, selectedHost.agentHost, selectedHost.id]);

  useEffect(() => {
    if (!folderOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFolderOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [folderOpen]);

  const selectHost = (nextHostId: string) => {
    const nextSeed = resolveRegionCwd(doc, center.x, center.y, nextHostId) ?? "~";
    setHostId(nextHostId);
    setCwd(nextSeed === "~" ? "" : nextSeed);
    setFolderSeed(nextSeed);
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
            data-canvas-menu-surface
            className="focus-surface-popover fixed w-[min(420px,calc(100vw-24px))] rounded-[7px] border border-stroke bg-ground p-3 shadow-[0_18px_42px_var(--color-shadow-1)]"
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
              hostId={hostId}
              initialPath={folderSeed}
              resetKey={folderSeed}
              onSelect={saveSelectedFolder}
            />
            <RegionDefaultFolderOption
              checked={useRegionDefault}
              disabled={!region || !cwd}
              showRegionHint={!region}
              onToggle={toggleRegionDefault}
              className="mt-0"
            />
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
      <div
        className={
          FLEET_UI_ENABLED
            ? "grid grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-2"
            : "grid gap-2"
        }
      >
        {FLEET_UI_ENABLED ? (
          <label className="grid gap-1 text-[10px] uppercase tracking-[0.1em] text-dim">
            Agent host
            <Select
              aria-label="Agent host"
              value={hostId}
              options={hosts.map((host) => ({ value: host.id, label: host.label }))}
              onChange={selectHost}
            />
          </label>
        ) : null}
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
