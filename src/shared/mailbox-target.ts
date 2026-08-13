/**
 * Resolve a mailbox CLI target to a canvas node id.
 *
 * Agents hold `VELLUM_COMMAND_NODE_REF` as `canvas:nodeId`. Passing that
 * string as `target` used to ScopeError. Own-inbox calls also omit target.
 */

export const resolveMailboxTarget = (
  raw: string | undefined,
  caller: { readonly canvasName: string; readonly nodeId: string },
): string => {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.length === 0) return caller.nodeId;
  if (trimmed === caller.nodeId) return caller.nodeId;
  const ownPrefixed = `${caller.canvasName}:${caller.nodeId}`;
  if (trimmed === ownPrefixed) return caller.nodeId;
  const sep = trimmed.indexOf(":");
  if (sep > 0) {
    const canvas = trimmed.slice(0, sep);
    const nodeId = trimmed.slice(sep + 1);
    if (canvas === caller.canvasName && nodeId.length > 0) return nodeId;
  }
  return trimmed;
};

export const isOwnMailboxTarget = (
  target: string,
  callerNodeId: string,
): boolean => target === callerNodeId;
