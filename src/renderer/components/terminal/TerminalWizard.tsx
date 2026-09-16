import { useEffect, useState } from "react";
import { LOCAL_HOST_ID, TERMINAL_HOST_CAPABILITY } from "@shared/remote-hosts";
import { resolveRegionCwd } from "@shared/region-defaults";
import { makeTerminalNode } from "../../lib/node-factories";
import { addNode } from "../../lib/mutations";
import { state$ } from "../../lib/state";
import { openTerminal } from "../../lib/terminal-actions";
import { getJuntoApi } from "../../lib/junto-api";
import { FocusSurface } from "../FocusSurface";
import { Button, Eyebrow, FieldLabel, Select } from "../ui";

type HostOpt = { readonly id: string; readonly label: string };

const TERMINAL_SIZE = { width: 260, height: 110 } as const;

const defaultHostId = (): string => {
  const stationHost = state$.settings.station.hostId.peek() || LOCAL_HOST_ID;
  return stationHost === LOCAL_HOST_ID ? LOCAL_HOST_ID : stationHost;
};

/** Create a terminal node at the anchor and open it — no host dialog. */
export const createTerminalAt = (
  anchor: { readonly x: number; readonly y: number },
  hostId: string = defaultHostId(),
): Promise<void> => {
  const host = hostId || LOCAL_HOST_ID;
  // Create-time cwd from containing region paths for the chosen host.
  const cwd = resolveRegionCwd(
    state$.doc.peek(),
    anchor.x + TERMINAL_SIZE.width / 2,
    anchor.y + TERMINAL_SIZE.height / 2,
    host,
  );
  const node = makeTerminalNode(
    anchor.x,
    anchor.y,
    { kind: "shell", ...(cwd ? { cwd } : {}) },
    "terminal",
    host,
  );
  addNode(node, { edit: false });
  state$.focusNodeId.set(node.id);
  return openTerminal(node);
};

export function TerminalWizard({
  anchor,
  onClose,
}: {
  readonly anchor: { x: number; y: number };
  readonly onClose: () => void;
}) {
  const [hostOptions, setHostOptions] = useState<HostOpt[]>([
    { id: LOCAL_HOST_ID, label: "this machine" },
  ]);
  const [hostId, setHostId] = useState(defaultHostId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = getJuntoApi();
    void api
      ?.hostsList?.()
      .then((res) => {
        if (!res?.ok || !Array.isArray(res.hosts)) return;
        // Local is this process (code default on the hosts API). Remotes must
        // declare terminal to appear — enrollment, not process fact.
        const opts = res.hosts
          .filter(
            (h) =>
              typeof h.id === "string" &&
              h.id.length > 0 &&
              Array.isArray(h.capabilities) &&
              h.capabilities.includes(TERMINAL_HOST_CAPABILITY),
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
        if (merged.length === 0) {
          merged.push({ id: LOCAL_HOST_ID, label: "this machine" });
        }
        merged.sort((a, b) => {
          if (a.id === LOCAL_HOST_ID) return -1;
          if (b.id === LOCAL_HOST_ID) return 1;
          return a.label.localeCompare(b.label);
        });
        setHostOptions(merged);
        setHostId((current) =>
          merged.some((h) => h.id === current)
            ? current
            : (merged.find((h) => h.id === LOCAL_HOST_ID)?.id ?? merged[0]!.id),
        );
      })
      .catch(() => undefined);
  }, []);

  const create = () => {
    if (busy) return;
    setBusy(true);
    void createTerminalAt(anchor, hostId).finally(() => {
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
          <Eyebrow tone="steel">terminal - create</Eyebrow>
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
