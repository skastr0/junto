/**
 * Canvas fixtures for process-bound, edge-scoped browser authorization e2e
 * scenarios.
 */
import type { CanvasNode, TextNode } from "../../src/shared/canvas";

/** Eligible agent seat whose live ACP child can be process-bound. */
export const browserAgentNode = (input: {
  readonly id: string;
  readonly agentKey: string;
  readonly label: string;
  readonly x?: number;
  readonly y?: number;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: 240,
  height: 96,
  ether: { entity: { kind: "agent", name: input.agentKey } },
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
}): CanvasNode => ({
  id: input.id,
  type: "link",
  url: input.url,
  x: input.x ?? 300,
  y: input.y ?? 0,
  width: 240,
  height: 80,
  ether: { entity: { kind: "page" }, browser: { profile: input.profile } },
});
