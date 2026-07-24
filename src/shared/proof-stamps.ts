/**
 * Proof / approval trust plane (S8).
 *
 * Stamps and human approvals live in **runtime state**, never as authorial
 * canvas fields. Phase evaluation consumes StampView / ApprovalView only —
 * forging metadata on a document artifact cannot clear a proof edge.
 *
 * Stamp write authority: admitted `artifact.publish` by a process-bound
 * principal (I16). Approval write authority: operator/human only — never a
 * node or agent principal.
 */

import type { Artifact } from "./canvas";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Proof stamp written only via admitted artifact.publish (process-bound). */
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

export type ArtifactPublishAuthority = {
  readonly kind: "admitted-artifact-publish";
  readonly canvasName: string;
  readonly seat: string;
  readonly occupant: string;
  readonly sinkNodeId: string;
};

export type OperatorHumanAuthority = {
  readonly kind: "operator-human-grant";
};

export const artifactPublishAuthority = (input: {
  readonly canvasName: string;
  readonly seat: string;
  readonly occupant: string;
  readonly sinkNodeId: string;
}): ArtifactPublishAuthority => ({
  kind: "admitted-artifact-publish",
  canvasName: input.canvasName,
  seat: input.seat,
  occupant: input.occupant,
  sinkNodeId: input.sinkNodeId,
});

export const operatorHumanAuthority = (): OperatorHumanAuthority => ({
  kind: "operator-human-grant",
});

// ---------------------------------------------------------------------------
// Extract stamp from published artifact metadata
// ---------------------------------------------------------------------------

/**
 * Build a ProofStamp from an admitted artifact.publish.
 * Requires authority (seat/occupant from process-bind) — document metadata alone
 * is insufficient; callers without authority must not call this.
 *
 * Metadata keys (on artifact.metadata):
 *   proofStep | step  — required string
 *   inputsHash        — required non-empty string
 *   evidenceRefs      — optional string[]
 *
 * Returns null when the publish is a plain artifact (no proof intent).
 */
export const extractProofStamp = (
  authority: ArtifactPublishAuthority,
  artifact: Artifact,
  ts: number = Date.now(),
): ProofStamp | null => {
  const meta = artifact.metadata;
  if (!meta || typeof meta !== "object") return null;

  const stepRaw = meta.proofStep ?? meta.step;
  if (typeof stepRaw !== "string" || stepRaw.trim().length === 0) return null;
  const step = stepRaw.trim();

  const hashRaw = meta.inputsHash;
  if (typeof hashRaw !== "string" || hashRaw.trim().length === 0) return null;
  const inputsHash = hashRaw.trim();

  const refsRaw = meta.evidenceRefs;
  const evidenceRefs: string[] = [];
  if (Array.isArray(refsRaw)) {
    for (const r of refsRaw) {
      if (typeof r === "string" && r.trim().length > 0) evidenceRefs.push(r.trim());
    }
  }
  // Always include the published artifact id as evidence.
  if (!evidenceRefs.includes(artifact.artifactId)) {
    evidenceRefs.push(artifact.artifactId);
  }

  return {
    step,
    seat: authority.seat,
    occupant: authority.occupant,
    inputsHash,
    evidenceRefs,
    ts,
  };
};

// ---------------------------------------------------------------------------
// Match helpers (pure phase inputs)
// ---------------------------------------------------------------------------

/**
 * Find a stamp on the source sink that satisfies proof criteria.
 * - step must match
 * - if expectedInputsHash is set, stamp.inputsHash must equal it (replay gate)
 */
export const findMatchingStamp = (
  stamps: ReadonlyArray<ProofStamp> | undefined,
  step: string,
  expectedInputsHash: string | undefined,
): ProofStamp | undefined => {
  if (!stamps || stamps.length === 0) return undefined;
  for (const stamp of stamps) {
    if (stamp.step !== step) continue;
    if (expectedInputsHash !== undefined && stamp.inputsHash !== expectedInputsHash) {
      continue;
    }
    return stamp;
  }
  return undefined;
};

export const findApproval = (
  approvals: ApprovalView | undefined,
  step: string,
): HumanApproval | undefined => approvals?.get(step);

// ---------------------------------------------------------------------------
// Mutable runtime store (main process). Not a document field.
// ---------------------------------------------------------------------------

export type StampRuntimeSnapshot = {
  readonly byCanvas: ReadonlyMap<
    string,
    ReadonlyMap<string, ReadonlyArray<ProofStamp>>
  >;
  readonly approvalsByCanvas: ReadonlyMap<
    string,
    ReadonlyMap<string, HumanApproval>
  >;
};

/** In-memory sink runtime. Process-local; restart re-baselines (like occupancy). */
export class StampRuntime {
  private readonly stamps = new Map<string, Map<string, ProofStamp[]>>();
  private readonly approvals = new Map<string, Map<string, HumanApproval>>();

  /**
   * Record a stamp. ONLY callable with admitted artifact.publish authority.
   * Seat/occupant on the stamp must match the authority (anti-forge).
   */
  recordStamp(authority: ArtifactPublishAuthority, stamp: ProofStamp): void {
    if (authority.kind !== "admitted-artifact-publish") {
      throw new Error("stamp write requires admitted-artifact-publish authority");
    }
    if (stamp.seat !== authority.seat || stamp.occupant !== authority.occupant) {
      throw new Error("stamp seat/occupant must match process-bound principal");
    }
    if (stamp.step.trim().length === 0 || stamp.inputsHash.trim().length === 0) {
      throw new Error("stamp step and inputsHash required");
    }
    let canvasMap = this.stamps.get(authority.canvasName);
    if (!canvasMap) {
      canvasMap = new Map();
      this.stamps.set(authority.canvasName, canvasMap);
    }
    const sinkId = authority.sinkNodeId;
    const list = canvasMap.get(sinkId) ?? [];
    // Replace same step+inputsHash (idempotent re-publish of identical proof);
    // keep history of distinct inputs hashes so replay of old hash still fails
    // when criteria advances.
    const next = list.filter(
      (s) => !(s.step === stamp.step && s.inputsHash === stamp.inputsHash),
    );
    next.push(stamp);
    canvasMap.set(sinkId, next);
  }

  /**
   * Direct write without authority — intentionally absent as a public API.
   * Tests that attempt to forge via document fields use empty StampView.
   */
  // no recordStampRaw

  recordApproval(
    authority: OperatorHumanAuthority,
    canvasName: string,
    approval: HumanApproval,
  ): void {
    if (authority.kind !== "operator-human-grant") {
      throw new Error("approval write requires operator-human-grant authority");
    }
    if (approval.principal !== "human") {
      throw new Error("approval principal must be human (external, never a node)");
    }
    if (approval.step.trim().length === 0) {
      throw new Error("approval step required");
    }
    let canvasMap = this.approvals.get(canvasName);
    if (!canvasMap) {
      canvasMap = new Map();
      this.approvals.set(canvasName, canvasMap);
    }
    canvasMap.set(approval.step, approval);
  }

  /** StampView for one canvas (pure snapshot for deriveExecutionGraph). */
  stampView(canvasName: string): StampView {
    const canvasMap = this.stamps.get(canvasName);
    if (!canvasMap) return new Map();
    return new Map(canvasMap);
  }

  approvalView(canvasName: string): ApprovalView {
    const canvasMap = this.approvals.get(canvasName);
    if (!canvasMap) return new Map();
    return new Map(canvasMap);
  }

  /** Test / doctor helper — full snapshot. */
  snapshot(): StampRuntimeSnapshot {
    return {
      byCanvas: new Map(
        [...this.stamps].map(([k, v]) => [k, new Map(v)] as const),
      ),
      approvalsByCanvas: new Map(
        [...this.approvals].map(([k, v]) => [k, new Map(v)] as const),
      ),
    };
  }

  clear(): void {
    this.stamps.clear();
    this.approvals.clear();
  }
}

/** Process-global store for the work plane. */
export const globalStampRuntime = new StampRuntime();
