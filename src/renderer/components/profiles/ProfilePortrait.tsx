import type { PortraitConfig } from "@shared/agent-portrait";
import type { AgentProfileBody } from "@shared/agent-profiles";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { SEVERITY_TONE } from "../../lib/activity";
import { ActivityMarkFromSpec } from "../ActivityMark";
import { AgentPortrait } from "../AgentPortrait";
import { portraitFor } from "../SeatRing";

const RESTING = { mode: "static", tone: SEVERITY_TONE.idle, label: "profile" } as const;

/**
 * A profile's face in its resting ring: the seat it will become, before it
 * exists. The portrait is the profile's own resolved character, so the ring
 * shows exactly the face a placed seat wears.
 */
export function ProfilePortrait({
  profileKey,
  body,
  px = 40,
}: {
  /** Stable key so the face caches per profile. */
  readonly profileKey: string;
  readonly body: AgentProfileBody;
  readonly px?: number;
}) {
  const size = portraitFor(px);
  return (
    <ActivityMarkFromSpec spec={RESTING} size="glance" unit={px}>
      <AgentPortrait
        identity={`profile:${profileKey}`}
        size={size}
        frame="round"
        outline={false}
        badge={size >= 28}
        harness={isHarnessId(body.harness) ? body.harness : undefined}
        config={(body.portrait ?? {}) as PortraitConfig}
        expression="resting"
      />
    </ActivityMarkFromSpec>
  );
}
