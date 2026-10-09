import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Sandbox } from "./sandbox";

/** Test-only inspection of the disposable app's private session store. */
export const readSeatSession = (sandbox: Sandbox, seatId: string, bindingId?: string): string | undefined => {
  if (!basename(sandbox.root).startsWith("junto-e2e-") || resolve(sandbox.homeDir) !== join(resolve(sandbox.root), "home"))
    throw new Error("Session inspection requires a disposable Junto E2E sandbox");
  const db = new DatabaseSync(join(sandbox.homeDir, ".junto", "state", "junto.db"), { readOnly: true });
  try {
    const row = db.prepare(
      "SELECT session_id FROM seat_sessions WHERE seat_id = ? AND ended_at IS NULL AND (? IS NULL OR binding_id = ?)",
    ).get(seatId, bindingId ?? null, bindingId ?? null) as { session_id: string } | undefined;
    return row?.session_id;
  } finally { db.close(); }
};
