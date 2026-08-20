import type { CanvasDoc } from "@shared/canvas";
import type { ClaimDef } from "@shared/work-model";
import { isGroup } from "@shared/graph";
import { nodeTitle } from "../../lib/presentation";

// Claims library v1 is an aggregation view, not storage: the composer reads
// every claim authored anywhere on the canvas and reuses one by COPY. The
// copy carries a fresh id and becomes its own law under its new owner, so
// origin here is provenance for the operator's eye, never a live reference.

export type ClaimOriginKind = "region" | "sink";

export type ClaimOrigin = {
  readonly kind: ClaimOriginKind;
  readonly nodeId: string;
  readonly label: string;
};

export type ReusableClaim = {
  readonly claim: ClaimDef;
  readonly origin: ClaimOrigin;
};

/** Every region-contract and sink-contract claim on the canvas, doc order. */
export const collectCanvasClaims = (
  doc: CanvasDoc,
): ReadonlyArray<ReusableClaim> => {
  const out: ReusableClaim[] = [];
  for (const node of doc.nodes) {
    if (isGroup(node)) {
      const label = nodeTitle(node);
      for (const claim of node.ether?.region?.contract?.claims ?? []) {
        out.push({ claim, origin: { kind: "region", nodeId: node.id, label } });
      }
      continue;
    }
    if (node.ether?.entity?.kind !== "task") continue;
    const label = nodeTitle(node);
    for (const claim of node.ether?.tasks?.contract?.claims ?? []) {
      out.push({ claim, origin: { kind: "sink", nodeId: node.id, label } });
    }
  }
  return out;
};

/**
 * Reuse candidates for one owner: everything on the canvas except the owner's
 * own claims (already standing law there) and anything whose text the owner
 * already carries verbatim — reusing a claim you already hold is a duplicate
 * law, not composition.
 */
export const reusableClaims = (
  doc: CanvasDoc,
  ownerNodeId: string,
  ownerClaims: ReadonlyArray<ClaimDef>,
): ReadonlyArray<ReusableClaim> => {
  const held = new Set(ownerClaims.map((claim) => claim.text.trim().toLowerCase()));
  return collectCanvasClaims(doc).filter(
    (entry) =>
      entry.origin.nodeId !== ownerNodeId &&
      !held.has(entry.claim.text.trim().toLowerCase()),
  );
};

/** Free-text filter over claim text, severity, and origin label. */
export const matchesClaimQuery = (entry: ReusableClaim, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.claim.text, entry.claim.severity, entry.origin.label]
    .join(" ")
    .toLowerCase()
    .includes(needle);
};

/** Copy-on-reuse: same words and severity, new identity. */
export const copyClaim = (claim: ClaimDef, id: string): ClaimDef => ({
  id,
  text: claim.text,
  severity: claim.severity,
});

export const claimOriginLabel = (origin: ClaimOrigin): string =>
  origin.kind === "region" ? `region ${origin.label}` : `sink ${origin.label}`;
