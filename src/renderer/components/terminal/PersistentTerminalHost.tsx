/**
 * Keep one TerminalSurface per open node across focus ↔ pin.
 * Zone trees register a slot; this host adopts the same DOM node into it.
 * Pin must not remount xterm or re-run ensure/create.
 */
import { useLayoutEffect, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import { panesForLayout } from "../../lib/surface-registry";
import { dock$, terminalSurfaceId } from "../../lib/dock-state";
import { terminal$, terminalSlots$ } from "../../lib/terminal-state";
import { TerminalSurface } from "./TerminalSurface";

export function PersistentTerminalHost() {
  const nodeIds = use$(() => Object.keys(terminal$.openByNodeId.get()));
  return (
    <div className="persistent-terminal-root" aria-hidden>
      {nodeIds.map((nodeId) => (
        <PersistentTerminal key={nodeId} nodeId={nodeId} />
      ))}
    </div>
  );
}

function PersistentTerminal({ nodeId }: { readonly nodeId: string }) {
  const node = use$(terminal$.openByNodeId[nodeId]);
  const slotValue = use$(terminalSlots$.elements[nodeId]);
  const slot = slotValue instanceof HTMLElement ? slotValue : null;
  const wellRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const visible = use$(() => {
    const surfaceId = terminalSurfaceId(nodeId);
    const surfaces = dock$.registry.surfaces.get();
    const surface = surfaces.find((candidate) => candidate.id === surfaceId);
    if (!surface) return false;
    const mru =
      surface.zone === "focus"
        ? dock$.registry.focusMru.get()
        : dock$.registry.pinnedMru.get();
    const layout =
      surface.zone === "focus"
        ? dock$.registry.focusLayout.get()
        : dock$.registry.pinnedLayout.get();
    return mru.slice(0, panesForLayout(layout)).includes(surfaceId);
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    const well = wellRef.current;
    if (!host || !well) return;
    const parent: HTMLElement = slot ?? well;
    if (host.parentElement !== parent) parent.appendChild(host);
    return () => {
      if (well.isConnected && host.parentElement !== well) {
        well.appendChild(host);
      }
    };
  }, [slot]);

  if (!node) return null;

  return (
    <div ref={wellRef} className="persistent-terminal-well" hidden>
      <div ref={hostRef} className="persistent-terminal-host">
        <TerminalSurface node={node} visible={visible} />
      </div>
    </div>
  );
}
