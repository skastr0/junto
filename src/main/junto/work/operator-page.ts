/**
 * The page a browser session shows, as the core's box-comment operations take
 * it: its canvas and node. Main reads it from the session, which lives here
 * because the page is Electron's; the type crosses the port as plain data, so
 * this module pulls in no core module.
 */
import { parseNodeRef } from "@shared/node-ref";
import type { BrowserSessionService } from "../browser/sessions";

export type OperatorPage = { readonly canvasName: string; readonly nodeId: string };

export const operatorPageOf = (sessions: Pick<BrowserSessionService, "state">, sessionId: string): OperatorPage | undefined => {
  const session = sessions.state(sessionId);
  if (!session.ok) return undefined;
  const ref = parseNodeRef(session.data.ref);
  return ref.ok ? { canvasName: ref.value.canvasName, nodeId: session.data.nodeId } : undefined;
};
