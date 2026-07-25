import { useEffect, useState } from "react";
import { TERMINAL_HOST_CAPABILITY } from "@shared/remote-hosts";
import { makeTerminalNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { openTerminal } from "../../lib/terminal-actions";
import { getVellumApi } from "../../lib/vellum-api";
import { FocusSurface } from "../FocusSurface";
import { Button, Eyebrow, FieldLabel, Select } from "../ui";

type HostOpt = { readonly id: string; readonly label: string };

export function TerminalWizard({
  anchor,
  onClose,
}: {
  readonly anchor: { x: number; y: number };
  readonly onClose: () => void;
}) {
  const stationHost = state$.settings.station.hostId.peek() || "local";
  const [hostOptions, setHostOptions] = useState<HostOpt[]>([
    { id: "local", label: "local" },
  ]);
  const [hostId, setHostId] = useState(stationHost === "local" ? "local" : stationHost);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = getVellumApi();
    void api
      ?.hostsList?.()
      .then((res) => {
        if (!res?.ok || !Array.isArray(res.hosts)) return;
        // Only hosts that declare the terminal capability (Vellum station
        // term-control surface). Remote without it cannot host native sessions.
        // Local is always offered as a floor: TermPlane runs on this process
        // even if hosts.json was stripped of the terminal cap (migration also
        // restores it on load).
        const opts = res.hosts
          .filter(
            (h) =>
              typeof h.id === "string" &&
              h.id.length > 0 &&
              Array.isArray(h.capabilities) &&
              (h.id === "local" || h.capabilities.includes(TERMINAL_HOST_CAPABILITY)),
          )
          .map((h) => ({
            id: h.id,
            label:
              h.kind === "remote"
                ? `${h.label || h.id} (remote)`
                : h.label || h.id,
          }));
        const seen = new Set<string>();
        const merged: HostOpt[] = [];
        for (const opt of opts) {
          if (seen.has(opt.id)) continue;
          seen.add(opt.id);
          merged.push(opt);
        }
        if (!seen.has("local")) {
          merged.unshift({ id: "local", label: "local" });
        }
        if (merged.length === 0) {
          merged.push({ id: "local", label: "local" });
        }
        // Local first for scanability.
        merged.sort((a, b) => {
          if (a.id === "local") return -1;
          if (b.id === "local") return 1;
          return a.label.localeCompare(b.label);
        });
        setHostOptions(merged);
        setHostId((current) =>
          merged.some((h) => h.id === current)
            ? current
            : (merged.find((h) => h.id === "local")?.id ?? merged[0]!.id),
        );
      })
      .catch(() => undefined);
  }, []);

  const create = () => {
    if (busy) return;
    setBusy(true);
    const node = makeTerminalNode(
      anchor.x,
      anchor.y,
      { kind: "shell" },
      "terminal",
      hostId || "local",
    );
    addNode(node, { edit: false });
    state$.focusNodeId.set(node.id);
    // Always start + open — no separate Start on the card.
    void openTerminal(node).finally(() => {
      setBusy(false);
      onClose();
    });
  };

  return (
    <FocusSurface measure="form" height="fit" layer="detail" label="New terminal" onClose={onClose}>
      <div
        className="grid gap-4 p-5"
        onKeyDown={(e) => {
          if (e.key === "Enter") create();
        }}
      >
        <div>
          <Eyebrow tone="steel">terminal · create</Eyebrow>
          <div className="mt-1 font-mono text-[16px] font-semibold text-ink">New terminal</div>
        </div>
        <FieldLabel>
          Host
          <Select
            aria-label="Host"
            value={hostId}
            options={hostOptions.map((h) => ({ value: h.id, label: h.label }))}
            onChange={setHostId}
          />
        </FieldLabel>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="subtle" onClick={onClose} disabled={busy}>
            cancel
          </Button>
          <Button size="sm" variant="primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create terminal"}
          </Button>
        </div>
      </div>
    </FocusSurface>
  );
}
