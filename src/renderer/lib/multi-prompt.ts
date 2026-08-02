import { getAgentChatState, openChat, sendPrompt } from "./chat-state";

export type MultiPromptTarget = {
  readonly nodeId: string;
  readonly agentKey: string;
};

export type MultiPromptResult = {
  readonly sent: number;
  readonly failed: ReadonlyArray<{
    readonly nodeId: string;
    readonly agentKey: string;
    readonly error: string;
  }>;
};

/**
 * Fan-out one prompt to many agent seats.
 * Opens a session when idle/closed/error; skips nothing on partial failure —
 * each target is independent. Never throws.
 */
export async function multiPromptAgents(
  targets: ReadonlyArray<MultiPromptTarget>,
  text: string,
): Promise<MultiPromptResult> {
  const trimmed = text.trim();
  if (!trimmed || targets.length === 0) {
    return { sent: 0, failed: [] };
  }

  const failed: Array<{ nodeId: string; agentKey: string; error: string }> = [];
  let sent = 0;

  await Promise.all(
    targets.map(async ({ nodeId, agentKey }) => {
      try {
        const before = getAgentChatState(agentKey);
        if (before.status !== "live") {
          await openChat(agentKey);
        }
        const after = getAgentChatState(agentKey);
        if (after.status !== "live") {
          failed.push({
            nodeId,
            agentKey,
            error: after.error ?? "chat not live",
          });
          return;
        }
        await sendPrompt(agentKey, trimmed);
        sent += 1;
      } catch (error) {
        failed.push({
          nodeId,
          agentKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return { sent, failed };
}
