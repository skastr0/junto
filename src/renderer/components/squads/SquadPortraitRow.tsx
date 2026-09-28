import type { PortraitConfig } from "@shared/agent-portrait";
import type { SquadBody } from "@shared/squads";
import { AgentPortrait } from "../AgentPortrait";

/** Most faces drawn before the row shows "+N". */
const ROW_MAX = 8;

/** A squad's seats as a row of portraits, drawn from the template itself. */
export function SquadPortraitRow({
  squadKey,
  squad,
  size = 22,
}: {
  /** Stable prefix so each face caches per squad seat. */
  readonly squadKey: string;
  readonly squad: SquadBody;
  readonly size?: number;
}) {
  const shown = squad.seats.slice(0, ROW_MAX);
  const more = squad.seats.length - shown.length;
  return (
    <span className="squad-portraits" aria-hidden>
      {shown.map((seat) => (
        <AgentPortrait
          key={seat.key}
          identity={`${squadKey}:${seat.key}`}
          size={size}
          frame="round"
          badge={false}
          outline={false}
          harness={seat.profile.harness}
          config={(seat.profile.portrait ?? {}) as PortraitConfig}
          expression="resting"
        />
      ))}
      {more > 0 ? <span className="squad-portraits__more">+{more}</span> : null}
    </span>
  );
}

// Face size and step per stack depth, inside the picker card's 48px art slot.
const STACK: Readonly<Record<number, { readonly size: number; readonly step: number }>> = {
  1: { size: 40, step: 0 },
  2: { size: 32, step: 16 },
  3: { size: 30, step: 9 },
};

/**
 * A squad as a stack of its first three faces on a diagonal, for the picker
 * card's art slot. The first seat sits in front, top left.
 */
export function SquadPortraitStack({
  squadKey,
  squad,
}: {
  readonly squadKey: string;
  readonly squad: SquadBody;
}) {
  const shown = squad.seats.slice(0, 3);
  const { size, step } = STACK[shown.length] ?? STACK[3]!;
  const inset = shown.length === 1 ? 4 : 0;
  return (
    <span className="squad-stack" aria-hidden>
      {shown
        .map((seat, index) => ({ seat, at: inset + index * step }))
        .reverse()
        .map(({ seat, at }) => (
          <span key={seat.key} className="squad-stack__face" style={{ left: at, top: at }}>
            <AgentPortrait
              identity={`${squadKey}:${seat.key}`}
              size={size}
              frame="round"
              badge={false}
              harness={seat.profile.harness}
              config={(seat.profile.portrait ?? {}) as PortraitConfig}
              expression="resting"
            />
          </span>
        ))}
    </span>
  );
}
