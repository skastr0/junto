import { useState } from "react";
import type { EtherTerminalLaunch } from "@shared/canvas";
import { makeTerminalNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import { state$ } from "../../lib/state";

export function TerminalWizard({ anchor, onClose }: { readonly anchor: { x: number; y: number }; readonly onClose: () => void }) {
  const [preset, setPreset] = useState<"shell" | "claude" | "codex" | "custom">("shell");
  const [command, setCommand] = useState("");
  const create = () => {
    const argv = preset === "claude" ? ["claude"] : preset === "codex" ? ["codex"] : preset === "custom" ? command.trim().split(/\s+/).filter(Boolean) : undefined;
    if (preset === "custom" && !argv?.length) return;
    const launch: EtherTerminalLaunch = argv ? { kind: preset === "custom" ? "command" : "harness", argv } : { kind: "shell" };
    const label = preset === "shell" ? "terminal" : preset;
    const node = makeTerminalNode(anchor.x, anchor.y, launch, label, state$.settings.station.hostId.peek() || "local");
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    onClose();
  };
  return <div className="terminal-wizard-backdrop" onMouseDown={onClose}>
    <section className="terminal-wizard" role="dialog" aria-modal="true" aria-label="New terminal" onMouseDown={(e) => e.stopPropagation()}>
      <header><span>NEW TERMINAL</span><button type="button" onClick={onClose}>×</button></header>
      <div className="terminal-wizard__presets">
        {(["shell", "claude", "codex", "custom"] as const).map((item) => <button type="button" key={item} className={preset === item ? "is-active" : ""} onClick={() => setPreset(item)}>{item}</button>)}
      </div>
      {preset === "custom" ? <input autoFocus value={command} onChange={(e) => setCommand(e.target.value)} placeholder="command and arguments" onKeyDown={(e) => { if (e.key === "Enter") create(); }} /> : null}
      <p>The card is created stopped. Nothing runs until you press Start.</p>
      <button type="button" className="terminal-wizard__create" onClick={create}>Create terminal</button>
    </section>
  </div>;
}
