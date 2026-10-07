import { useState } from "react";
import { LogOut } from "lucide-react";
import { agentCountLabel } from "../../lib/multi-selection";
import { OFFBOARD_PANEL_SIDES, OFFBOARD_PANEL_WIDTH, SeatOffboardPanel } from "../nodes/SeatOffboard";
import { Popover } from "../ui";
import { KindKey } from "./RtsControls";

/**
 * The same panel from the RTS bar's middle section: one key for the selected
 * agent, or for every agent in the selection.
 */
export function SeatOffboardKindKey({ nodeIds }: { readonly nodeIds: ReadonlyArray<string> }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const count = nodeIds.length;
  if (count === 0) return null;
  const label = count === 1 ? "Offboard agent" : `Offboard ${agentCountLabel(count)}`;
  return (
    <>
      <KindKey
        label={label}
        title={count === 1 ? "Offboard: end this agent's session" : `Offboard: end the sessions of ${agentCountLabel(count)}`}
        active={anchor !== null}
        testId="rts-seat-offboard"
        onClick={(event) => {
          const button = event.currentTarget;
          setAnchor((open) => (open ? null : button));
        }}
      >
        <LogOut size={12} />
      </KindKey>
      {anchor ? (
        <Popover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          label={label}
          sides={OFFBOARD_PANEL_SIDES}
          align="center"
          width={OFFBOARD_PANEL_WIDTH}
          className="seat-offboard-popover"
        >
          <SeatOffboardPanel nodeIds={nodeIds} />
        </Popover>
      ) : null}
    </>
  );
}
