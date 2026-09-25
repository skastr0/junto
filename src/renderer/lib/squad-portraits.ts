/**
 * Where squads read and write seat portrait overrides. The only coupling
 * between squads and the portrait store: capture reads one seat's override,
 * placement saves the copied overrides for the new seats.
 */
import type { PortraitConfig } from "@shared/agent-portrait";
import { portraitOverrides$, savePortraitOverride } from "./portrait-overrides-state";

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
