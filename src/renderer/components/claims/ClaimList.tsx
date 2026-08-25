import { useEffect, useMemo, useState } from "react";
import { Copy, Plus, X } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import { ulid } from "ulid";
import type { ClaimDef, ClaimSeverity } from "@shared/work-model";
import { state$ } from "../../lib/state";
import { HUE, withAlpha } from "../../lib/theme";
import { Button, Chip, IconButton, Input } from "../ui";
import {
  claimOriginLabel,
  copyClaim,
  matchesClaimQuery,
  reusableClaims,
  type ReusableClaim,
} from "./claim-sources";

// Claims are prompts checked by minds. Authoring is three moves — words,
// hard or soft, gone — plus reuse of a claim already standing somewhere else
// on the canvas. Nothing here judges or verifies; the work service only ever
// checks that a response exists.

const severityHue = (severity: ClaimSeverity): string =>
  severity === "hard" ? HUE.amber : HUE.steel;

function SeverityToggle({
  severity,
  noun,
  onChange,
}: {
  readonly severity: ClaimSeverity;
  readonly noun: "claim" | "check";
  readonly onChange: (next: ClaimSeverity) => void;
}) {
  const hue = severityHue(severity);
  return (
    <button
      type="button"
      className="inspector-flag-toggle shrink-0"
      aria-label={
        severity === "hard"
          ? `Hard ${noun}, switch to soft`
          : `Soft ${noun}, switch to hard`
      }
      title={
        severity === "hard"
          ? "Hard — must be answered before the task closes"
          : "Soft — may be waived with a reason"
      }
      style={{
        color: hue,
        borderColor: withAlpha(hue, 0.5),
        background: withAlpha(hue, 0.1),
      }}
      onClick={() => onChange(severity === "hard" ? "soft" : "hard")}
    >
      {severity}
    </button>
  );
}

function ClaimRow({
  claim,
  noun,
  onChange,
  onRemove,
}: {
  readonly claim: ClaimDef;
  readonly noun: "claim" | "check";
  readonly onChange: (next: ClaimDef) => void;
  readonly onRemove: () => void;
}) {
  const [draft, setDraft] = useState(claim.text);
  useEffect(() => {
    setDraft(claim.text);
  }, [claim.id, claim.text]);

  const commit = () => {
    const text = draft.trim();
    if (!text || text === claim.text) {
      setDraft(claim.text);
      return;
    }
    onChange({ ...claim, text });
  };

  return (
    <div className="flex items-center gap-1.5">
      <SeverityToggle
        severity={claim.severity}
        noun={noun}
        onChange={(severity) => onChange({ ...claim, severity })}
      />
      <Input
        data-focus-owner="canvas-draft"
        aria-label={`${noun === "check" ? "Check" : "Claim"} text`}
        className="min-h-[28px] py-1 text-[11px]"
        value={draft}
        placeholder="what must be true before this closes?"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(claim.text);
            event.currentTarget.blur();
          }
        }}
      />
      <IconButton
        size="sm"
        tone="danger"
        aria-label={`Remove ${noun}`}
        title={`Remove ${noun}`}
        onClick={onRemove}
      >
        <X size={12} />
      </IconButton>
    </div>
  );
}

/**
 * New-claim row. A claim with no words is not a claim, so the draft lives
 * here until it has text — the document never sees an empty one.
 */
function ClaimDraftRow({
  noun,
  onAdd,
  onCancel,
}: {
  readonly noun: "claim" | "check";
  readonly onAdd: (claim: ClaimDef) => void;
  readonly onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<ClaimSeverity>("hard");

  const commit = () => {
    const words = text.trim();
    if (!words) {
      onCancel();
      return;
    }
    onAdd({ id: ulid(), text: words, severity });
  };

  return (
    <div className="mt-2 flex items-center gap-1.5">
      <SeverityToggle severity={severity} noun={noun} onChange={setSeverity} />
      <Input
        data-focus-owner="canvas-draft"
        aria-label={`New ${noun} text`}
        className="min-h-[28px] py-1 text-[11px]"
        autoFocus
        value={text}
        placeholder="what must be true before this closes?"
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            setText("");
            onCancel();
          }
        }}
      />
      <IconButton
        size="sm"
        aria-label={`Discard new ${noun}`}
        title="Discard"
        // Keep focus on the input: a blur here would commit the very draft
        // this button exists to throw away.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onCancel}
      >
        <X size={12} />
      </IconButton>
    </div>
  );
}

function ClaimReusePicker({
  lineCandidates,
  canvasCandidates,
  scoped,
  noun,
  onPick,
  onClose,
}: {
  readonly lineCandidates: ReadonlyArray<ReusableClaim>;
  readonly canvasCandidates: ReadonlyArray<ReusableClaim>;
  readonly scoped: boolean;
  readonly noun: "claim" | "check";
  readonly onPick: (entry: ReusableClaim) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showCanvas, setShowCanvas] = useState(false);
  const candidates = scoped && !showCanvas ? lineCandidates : canvasCandidates;
  const filtered = candidates.filter((entry) => matchesClaimQuery(entry, query));
  const plural = noun === "check" ? "checks" : "claims";

  return (
    <div className="mt-2 rounded-[5px] border border-stroke bg-inset/60 p-2">
      <div className="flex items-center gap-1.5">
        <Input
          data-focus-owner="canvas-draft"
          aria-label={`Find an existing ${noun}`}
          className="min-h-[28px] py-1 text-[11px]"
          value={query}
          placeholder={`find an existing ${noun}`}
          onChange={(event) => setQuery(event.target.value)}
        />
        <IconButton size="sm" aria-label={`Close existing ${noun} picker`} title="Close" onClick={onClose}>
          <X size={12} />
        </IconButton>
      </div>
      {scoped ? (
        <div className="mt-2 flex items-center gap-1" aria-label="Copy scope">
          <Button
            size="xs"
            variant={!showCanvas ? "primary" : "subtle"}
            aria-pressed={!showCanvas}
            onClick={() => setShowCanvas(false)}
          >
            this line {lineCandidates.length}
          </Button>
          <Button
            size="xs"
            variant={showCanvas ? "primary" : "subtle"}
            aria-pressed={showCanvas}
            onClick={() => setShowCanvas(true)}
          >
            entire canvas {canvasCandidates.length}
          </Button>
        </div>
      ) : null}
      <div className="inspector-detail mt-2">
        {scoped && !showCanvas
          ? `Showing ${plural} from stations and regions on this line.`
          : `Showing ${plural} from the entire canvas.`}
      </div>
      {filtered.length === 0 ? (
        <div className="inspector-detail mt-2">
          {candidates.length === 0
            ? `No other ${plural} are available in this scope.`
            : `No ${noun} matches this filter.`}
        </div>
      ) : (
        <div className="mt-2 grid max-h-48 gap-1 overflow-auto" role="list">
          {filtered.map((entry) => (
            <button
              key={`${entry.origin.nodeId}:${entry.claim.id}`}
              type="button"
              role="listitem"
              className="grid gap-1 rounded-[4px] border border-transparent px-1.5 py-1 text-left transition-colors hover:border-stroke hover:bg-white/[0.04]"
              title={`Copy into this contract — from ${claimOriginLabel(entry.origin)}`}
              onClick={() => onPick(entry)}
            >
              <span className="text-[11px] leading-snug text-ink">{entry.claim.text}</span>
              <span className="flex flex-wrap items-center gap-1">
                <Chip tone={entry.claim.severity === "hard" ? "amber" : "steel"}>
                  {entry.claim.severity}
                </Chip>
                <Chip tone={entry.origin.kind === "region" ? "violet" : "cyan"}>
                  {claimOriginLabel(entry.origin)}
                </Chip>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="inspector-detail mt-2">
        {noun === "check"
          ? "Copying creates a separate check at this stop."
          : "Copying creates separate law in this contract."}
      </div>
    </div>
  );
}

/**
 * Claims editor shared by the region and sink contracts. Reuse reads every
 * claim on the canvas (aggregation view — there is no claims store) and
 * copies the chosen one in with a fresh id.
 */
export function ClaimList({
  ownerNodeId,
  claims,
  label,
  hint,
  scopeNodeIds,
  vocabulary = "claim",
  onChange,
}: {
  readonly ownerNodeId: string;
  readonly claims: ReadonlyArray<ClaimDef>;
  readonly label: string;
  readonly hint?: string;
  /** Creation-line stations. Their region stacks join the default copy scope. */
  readonly scopeNodeIds?: ReadonlyArray<string>;
  readonly vocabulary?: "claim" | "check";
  readonly onChange: (next: ReadonlyArray<ClaimDef>) => void;
}) {
  const doc = use$(state$.doc);
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    setPicking(false);
    setAdding(false);
  }, [ownerNodeId]);

  const canvasCandidates = useMemo(
    () => reusableClaims(doc, ownerNodeId, claims),
    [claims, doc, ownerNodeId],
  );
  const lineCandidates = useMemo(
    () => reusableClaims(doc, ownerNodeId, claims, scopeNodeIds),
    [claims, doc, ownerNodeId, scopeNodeIds],
  );
  const candidates = scopeNodeIds === undefined ? canvasCandidates : lineCandidates;

  const replaceAt = (index: number, next: ClaimDef) =>
    onChange(claims.map((claim, i) => (i === index ? next : claim)));

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">{label}</div>
      {hint ? <div className="inspector-detail mt-1">{hint}</div> : null}
      {claims.length > 0 ? (
        <div className="mt-2 grid gap-1.5">
          {claims.map((claim, index) => (
            <ClaimRow
              key={claim.id}
              claim={claim}
              noun={vocabulary}
              onChange={(next) => replaceAt(index, next)}
              onRemove={() => onChange(claims.filter((_, i) => i !== index))}
            />
          ))}
        </div>
      ) : null}
      {adding ? (
        <ClaimDraftRow
          noun={vocabulary}
          onAdd={(claim) => {
            onChange([...claims, claim]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          size="xs"
          aria-label={`Add ${vocabulary}`}
          onClick={() => {
            setPicking(false);
            setAdding(true);
          }}
        >
          <Plus size={11} />
          {`add ${vocabulary}`}
        </Button>
        {canvasCandidates.length > 0 ? (
          <Button
            size="xs"
            variant="subtle"
            aria-label={`Copy an existing ${vocabulary}`}
            aria-pressed={picking}
            onClick={() => {
              setAdding(false);
              setPicking((open) => !open);
            }}
          >
            <Copy size={11} />
            copy existing {canvasCandidates.length}
          </Button>
        ) : null}
      </div>
      {picking ? (
        <ClaimReusePicker
          lineCandidates={lineCandidates}
          canvasCandidates={canvasCandidates}
          scoped={scopeNodeIds !== undefined}
          noun={vocabulary}
          onPick={(entry) => {
            onChange([...claims, copyClaim(entry.claim, ulid())]);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}
