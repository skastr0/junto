/**
 * Canvas fixtures for process-bound, edge-scoped browser authorization e2e
 * scenarios.
 */
import { modelNode } from "./model";
import { THIS_MACHINE } from "../../tests/support/machines";

/** Eligible agent seat whose live ACP child can be process-bound. */
export const browserAgentNode = (input: {
  readonly id: string;
  readonly agentKey: string;
  readonly label: string;
  readonly x?: number;
  readonly y?: number;
}) => modelNode({
  kind: "agent", id: input.id, agentKey: input.agentKey, label: input.label,
  bindingId: input.agentKey, harness: "codex", host: THIS_MACHINE, overseer: false, onRemove: "detach",
  x: input.x ?? 0, y: input.y ?? 0, width: 240, height: 96, z: 0,
});

/** A "page" link node — the browser-automation target scope. `url` must
 * pass classifyBrowserTarget (public canonical DNS name, never localhost);
 * the target is never actually navigated to in these scenarios, only used
 * as an authorization-scope target. */
export const browserPageNode = (input: {
  readonly id: string;
  readonly url: string;
  readonly profile: string;
  readonly x?: number;
  readonly y?: number;
}) => modelNode({
  kind: "page", id: input.id, url: input.url, profile: input.profile,
  host: THIS_MACHINE, onRemove: "kill-session",
  x: input.x ?? 300, y: input.y ?? 0, width: 240, height: 80, z: 0,
});
