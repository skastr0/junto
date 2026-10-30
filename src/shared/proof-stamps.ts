/**
 * Proof / approval trust plane (S8).
 *
 * Stamps and human approvals live in **runtime state**, never as authorial
 * canvas fields. Phase evaluation consumes StampView / ApprovalView only —
 * forging metadata on a document artifact cannot clear a proof edge.
 *
 * Approval write authority: operator/human only — never a node or agent
 * principal.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Proof stamp: a step, its seat and occupant, and the inputs it proved. */
export type ProofStamp = {
  readonly step: string;
  readonly seat: string;
  readonly occupant: string;
  readonly inputsHash: string;
  readonly evidenceRefs: ReadonlyArray<string>;
  /** Unix epoch ms. Runtime-only; digest formats without relying on wall clock. */
  readonly ts: number;
};

/** Human grant — external principal, never a canvas node. */
export type HumanApproval = {
  readonly step: string;
  /** Always the human principal token; never a node id. */
  readonly principal: "human";
  readonly ts: number;
  readonly note?: string;
};

/**
 * Sink node id → stamps published into that sink.
 * Missing key or empty array = no stamps for that sink.
 */
export type StampView = ReadonlyMap<string, ReadonlyArray<ProofStamp>>;

/** step → human approval (one live grant per step key). */
export type ApprovalView = ReadonlyMap<string, HumanApproval>;

// ---------------------------------------------------------------------------
// Authority tokens (branded by construction — only the admitted path mints)
// ---------------------------------------------------------------------------

export type OperatorHumanAuthority = {
  readonly kind: "operator-human-grant";
};

// ---------------------------------------------------------------------------
// Match helpers (pure phase inputs)
// ---------------------------------------------------------------------------

