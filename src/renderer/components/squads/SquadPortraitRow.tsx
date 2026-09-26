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
