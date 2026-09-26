/**
 * Where squads and profiles read and write a seat's saved character, soul,
 * and instructions. Capture reads one seat's; placement saves the copies for
 * the new seats.
 */
import type { PortraitConfig } from "@shared/agent-portrait";
import type { SeatGuidance } from "@shared/seat-guidance";
import { portraitOverrides$, savePortraitOverride } from "./portrait-overrides-state";
import { saveSeatGuidance } from "./seat-guidance-state";

/** The operator's saved override for one seat, if any. */
export const squadPortraitOf = (nodeId: string): PortraitConfig | undefined =>
  portraitOverrides$[nodeId].peek() as PortraitConfig | undefined;

/** Save overrides for freshly placed seats. False when the store refused any. */
export const saveSquadPortraits = async (
  byNodeId: Readonly<Record<string, PortraitConfig>>,
): Promise<boolean> => {
  const results = await Promise.all(
    Object.entries(byNodeId).map(([nodeId, config]) => savePortraitOverride(nodeId, config)),
  );
  return results.every(Boolean);
};

/** Save soul and instructions for freshly placed seats. False when any was refused. */
export const saveSeatGuidances = async (
  byNodeId: Readonly<Record<string, SeatGuidance>>,
): Promise<boolean> => {
  const results = await Promise.all(
    Object.entries(byNodeId).map(([nodeId, guidance]) => saveSeatGuidance(nodeId, guidance)),
  );
  return results.every((reason) => reason === "");
};
