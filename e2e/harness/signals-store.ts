/**
 * What the core persisted for a canvas's agent signals, read from the
 * sandbox's own store (the junto.db writeFixtureAgentSignals seeds,
 * sandbox.ts): opened read-only, never written, and closed after each read.
 * For the checks of a state no surface shows: a seeded or automation
 * signal's answer, and the step and raised values an automation's signal
 * keeps on the desktop. It reads what was persisted, as a pairing spec reads
 * authorized_keys; it is not a probe into the running app.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { Sandbox } from "./sandbox";

/** A signal as the store holds it: the fields these checks read. */
export type StoredSignal = {
  readonly signalId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly text: string;
  readonly state: string;
  readonly source?: Record<string, unknown> & { readonly automationId?: string };
  readonly response?: { readonly text: string; readonly at: number };
};

type Row = {
  readonly signal_id: string;
  readonly node_id: string;
  readonly kind: string;
  readonly text: string;
  readonly state: string;
  readonly source_json: string | null;
  readonly response_text: string | null;
  readonly response_at: number | null;
};

/** Every signal of one canvas the store holds, oldest first. */
export const signalsInStore = (sandbox: Sandbox, canvasName: string): ReadonlyArray<StoredSignal> => {
  const db = new DatabaseSync(join(sandbox.homeDir, ".junto", "state", "junto.db"), {
    open: true,
    readOnly: true,
    allowExtension: false,
    timeout: 5_000,
  });
  try {
    const rows = db
      .prepare(
        `SELECT signal_id, node_id, kind, text, state, source_json, response_text, response_at
           FROM agent_signals WHERE canvas_name = ? ORDER BY created_at, signal_id`,
      )
      .all(canvasName) as unknown as ReadonlyArray<Row>;
    return rows.map((row) => ({
      signalId: row.signal_id,
      nodeId: row.node_id,
      kind: row.kind,
      text: row.text,
      state: row.state,
      ...(row.source_json === null ? {} : { source: JSON.parse(row.source_json) as StoredSignal["source"] }),
      ...(row.response_text === null || row.response_at === null
        ? {}
        : { response: { text: row.response_text, at: Number(row.response_at) } }),
    }));
  } finally {
    db.close();
  }
};
