import { useEffect, useState } from "react";
import type { EtherTerminalLaunch } from "@shared/canvas";
import { makeTerminalNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";

type HostOpt = { readonly id: string; readonly label: string };

export function TerminalWizard({ anchor, onClose }: { readonly anchor: { x: number; y: number }; readonly onClose: () => void }) {
  const [preset, setPreset] = useState<"shell" | "claude" | "codex" | "custom">("shell");
  const [command, setCommand] = useState("");
  const stationHost = state$.settings.station.hostId.peek() || "local";
  const [hostOptions, setHostOptions] = useState<HostOpt[]>([
    { id: "local", label: "local" },
  ]);
  const [hostId, setHostId] = useState(stationHost === "local" ? "local" : stationHost);

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
                : h.label || h.id,
          }));
        // Always keep local first; append registered hosts (local may already be in registry).
        const seen = new Set<string>(["local"]);
        const merged: HostOpt[] = [{ id: "local", label: "local" }];
        for (const opt of opts) {
          if (seen.has(opt.id)) continue;
          seen.add(opt.id);
          merged.push(opt);
        }
        setHostOptions(merged);
      })
      .catch(() => undefined);
  }, []);
  const create = () => {
    const argv = preset === "claude" ? ["claude"] : preset === "codex" ? ["codex"] : preset === "custom" ? command.trim().split(/\s+/).filter(Boolean) : undefined;
    if (preset === "custom" && !argv?.length) return;
    const launch: EtherTerminalLaunch = argv ? { kind: preset === "custom" ? "command" : "harness", argv } : { kind: "shell" };
    const label = preset === "shell" ? "terminal" : preset;
    const node = makeTerminalNode(anchor.x, anchor.y, launch, label, hostId || "local");
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    onClose();
  };
  return <div className="terminal-wizard-backdrop" onMouseDown={onClose}>
    <section className="terminal-wizard" role="dialog" aria-modal="true" aria-label="New terminal" onMouseDown={(e) => e.stopPropagation()}>
      <header><span>NEW TERMINAL</span><button type="button" onClick={onClose}>×</button></header>
      <label className="terminal-wizard__host">
        <span>Host</span>
        <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
          {hostOptions.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
        </select>
      </label>
      <div className="terminal-wizard__presets">
        {(["shell", "claude", "codex", "custom"] as const).map((item) => <button type="button" key={item} className={preset === item ? "is-active" : ""} onClick={() => setPreset(item)}>{item}</button>)}
      </div>
      {preset === "custom" ? <input autoFocus value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command and arguments" onKeyDown={(e) => { if (e.key === "Enter") create(); }} /> : null}
      <p>Runs on the selected host. Remote needs Vellum running there. Card stays stopped until Start.</p>
      <button type="button" className="terminal-wizard__create" onClick={create}>Create terminal</button>
    </section>
  </div>;
}
