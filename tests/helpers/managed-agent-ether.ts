/**
 * Legal managed-agent ether for fixtures — kind agent requires
 * name + terminal.bindingId + terminal.harness (sanitize demotes otherwise).
 */
export const managedAgentEther = (
  agentKey: string,
  over: {
    readonly bindingId?: string;
    readonly harness?: string;
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
