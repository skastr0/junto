import { useEffect, useState } from "react";
import type { EtherTerminalLaunch } from "@shared/canvas";
import { makeTerminalNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { getVellumApi } from "../../lib/vellum-api";
import { FocusSurface } from "../FocusSurface";
import { Button, Eyebrow, FieldLabel, Input, Select } from "../ui";

type HostOpt = { readonly id: string; readonly label: string };
type Preset = "shell" | "claude" | "codex" | "custom";

const PRESETS: ReadonlyArray<Preset> = ["shell", "claude", "codex", "custom"];

export function TerminalWizard({ anchor, onClose }: { readonly anchor: { x: number; y: number }; readonly onClose: () => void }) {
  const [preset, setPreset] = useState<Preset>("shell");
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
  return (
    <FocusSurface measure="form" height="fit" layer="detail" label="New terminal" onClose={onClose}>
      <div className="grid gap-4 p-5" onKeyDown={(e) => { if (e.key === "Enter" && preset === "custom") create(); }}>
        <div>
          <Eyebrow tone="steel">terminal · attach</Eyebrow>
          <div className="mt-1 font-mono text-[16px] font-semibold text-ink">New terminal</div>
        </div>
        <FieldLabel>
          Host
          <Select aria-label="Host" value={hostId} onChange={(e) => setHostId(e.target.value)}>
            {hostOptions.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </Select>
        </FieldLabel>
        <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Launch preset">
          {PRESETS.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={preset === item ? "primary" : "chrome"}
              onClick={() => setPreset(item)}
            >
              {item}
            </Button>
          ))}
        </div>
        {preset === "custom" ? (
          <Input
            autoFocus
            aria-label="Command and arguments"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="command and arguments"
          />
        ) : null}
        <p className="text-[10px] leading-relaxed text-faint">
          Runs on the selected host. Remote needs Vellum running there. Card stays stopped until Start.
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="subtle" onClick={onClose}>cancel</Button>
          <Button size="sm" variant="primary" onClick={create}>Create terminal</Button>
        </div>
      </div>
    </FocusSurface>
  );
}
