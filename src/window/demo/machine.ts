import type { Node } from "@shared/model";

/**
 * What a scenario writes for a node that runs on this machine. A scenario is
 * written once and played on any machine, so the real name is filled in as
 * the node lands on the canvas.
 */
export const DEMO_THIS_MACHINE = "this-machine";

const KEY_PREFIX = `${DEMO_THIS_MACHINE}:`;

/** A scenario node as it lands on the machine called `machine`. */
export const onDemoMachine = (node: Node, machine: string): Node => {
  if (!("host" in node) || node.host !== DEMO_THIS_MACHINE) return node;
  const placed = { ...node, host: machine };
  return "agentKey" in placed && placed.agentKey.startsWith(KEY_PREFIX)
    ? { ...placed, agentKey: `${machine}:${placed.agentKey.slice(KEY_PREFIX.length)}` }
    : placed;
};
