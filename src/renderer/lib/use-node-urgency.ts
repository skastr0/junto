import { useEffect } from "react";
import { publishNodeUrgency, type Urgency } from "./region-urgency";

/**
 * A non-seat card says its state to its region (region-urgency.ts): blocked,
 * needs you or review, or nothing when calm. Cleared when the card goes.
 */
export const useNodeUrgency = (nodeId: string, urgency: Urgency | undefined): void => {
  useEffect(() => {
    publishNodeUrgency(nodeId, urgency);
  }, [nodeId, urgency]);
  useEffect(() => () => publishNodeUrgency(nodeId, undefined), [nodeId]);
};
