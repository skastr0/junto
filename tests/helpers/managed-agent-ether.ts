import type { HarnessId } from "../../src/shared/managed-terminal-templates";

/**
 * Legal managed-agent ether for fixtures — the actor seat requires
 * name + terminal.bindingId + terminal.harness, and the harness must be a
 * real template id or the document does not decode.
 */
export const managedAgentEther = (
  agentKey: string,
  over: {
    readonly bindingId?: string;
    readonly harness?: HarnessId;
    readonly host?: string;
  } = {},
) => ({
  entity: { kind: "agent" as const, name: agentKey },
  terminal: {
    bindingId: over.bindingId ?? `bind-${agentKey.replace(/[^a-z0-9]+/gi, "-")}`,
    harness: over.harness ?? "claude",
    launch: { kind: "harness" as const, argv: [over.harness ?? "claude"] },
  },
  ...(over.host ? { host: over.host } : {}),
});
