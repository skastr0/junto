/**
 * Normalize herdr events.subscribe push lines to a single internal shape.
 *
 * Real wire (protocol 16, herdr api_ping + schema):
 *   lifecycle:  { "event": "workspace_created", "data": { "type": "…", "workspace": {…} } }
 *   subscription: { "event": "pane.agent_status_changed", "data": { "pane_id", "agent_status", … } }
 *
 * Internal (mirror applyEvent):
 *   { kind: "workspace.created" | "pane.agent_status_changed" | …, body: flat record with ids }
 *
 * Also accepts the legacy flat test shape { type: "workspace.created", workspace_id, … }
 * so unit tests can migrate gradually.
 */

export type Rec = Record<string, unknown>;

const asRecord = (value: unknown): Rec | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Herdr EventKind serializes as snake_case (`workspace_created`); SubscriptionEventKind
 * as dotted (`pane.agent_status_changed`). Internal kinds are always dotted.
 */
export const normalizeHerdrEventKind = (raw: string): string => {
  if (raw.includes(".")) return raw;
  const m = raw.match(/^(workspace|tab|pane|worktree|layout)_(.+)$/);
  if (m) return `${m[1]}.${m[2]}`;
  return raw;
};

export interface NormalizedHerdrEvent {
  readonly kind: string;
  readonly body: Rec;
}

/**
 * Flatten herdr EventData / SubscriptionEventData into a record the mirror can upsert.
 * Nested workspace / tab / pane / agent objects are merged so ids sit at the top level.
 */
export const flattenHerdrEventData = (data: Rec): Rec => {
  const nested =
    asRecord(data.workspace) ??
    asRecord(data.tab) ??
    asRecord(data.pane) ??
    asRecord(data.agent);
  if (!nested) return { ...data };
  // Nested record wins for overlapping keys (authoritative entity fields).
  const { workspace: _w, tab: _t, pane: _p, agent: _a, type: _type, ...rest } = data;
  return { ...rest, ...nested };
};

/** Pure: raw JSON line object → internal kind + body, or null if unusable. */
export const normalizeHerdrEvent = (raw: unknown): NormalizedHerdrEvent | null => {
  const evt = asRecord(raw);
  if (!evt) return null;

  const kindRaw = str(evt.event) ?? str(evt.type) ?? str(evt.kind);
  if (!kindRaw) return null;
  const kind = normalizeHerdrEventKind(kindRaw);

  const data = asRecord(evt.data);
  if (data) {
    return { kind, body: flattenHerdrEventData(data) };
  }

  // Legacy flat shape (tests / accidental): drop routing keys, keep rest.
  const { event: _e, type: _ty, kind: _k, data: _d, ...rest } = evt;
  return { kind, body: rest };
};
