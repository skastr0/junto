import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import type {
  CheckDef,
  ClaimDef,
  SinkAdmission,
  TasksInboundContract,
  TasksOutboundContract,
  TasksSinkContract,
} from "@shared/work-model";
import { resolveSinkAdmission } from "@shared/work-model";
import { effectiveClaimsStack } from "@shared/claims";
import { state$ } from "../../lib/state";
import { setSinkContract } from "../../lib/mutations";
import { Chip, Select } from "../ui";
import { ClaimList } from "./ClaimList";
import { CheckList } from "./CheckList";
import {
  admissionChoiceLabel,
  admissionLabel,
  ADMISSION_ORDER,
} from "../../lib/admission-labels";
import { formatBakeTime, normalizeSinkContract, parseBakeTime } from "./sink-contract";

// The sink contract is what a station is: its purpose, its standing law, how
// arrivals become claimable, and what it publishes forward. A full station
// view opens both sides; board-column entry opens only the side it names.

const ADMISSION_OPTIONS: ReadonlyArray<{ readonly value: SinkAdmission; readonly label: string }> =
  ADMISSION_ORDER.map((value) => ({
    value,
    label: admissionChoiceLabel(value),
  }));

const openFoldsFor = (focusSide: "inbound" | "outbound" | undefined) => ({
  inbound: focusSide !== "outbound",
  outbound: focusSide !== "inbound",
});

function ContractText({
  label,
  hint,
  value,
  placeholder,
  ariaLabel,
  resetKey,
  onCommit,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly resetKey: string;
  readonly onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [resetKey, value]);

  const commit = () => {
    if (draft.trim() === value.trim()) return;
    onCommit(draft);
  };

  return (
    <label className="inspector-editor">
      <span>{label}</span>
      {hint ? <span className="inspector-detail normal-case tracking-normal">{hint}</span> : null}
      <textarea
        data-focus-owner="canvas-draft"
        aria-label={ariaLabel}
        value={draft}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function Fold({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="inspector-section">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 text-left"
        aria-expanded={open}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="inspector-section__label">{title}</span>
        <span className="ml-auto text-[9px] tracking-[0.1em] text-faint lowercase">{summary}</span>
      </button>
      {open ? children : null}
    </div>
  );
}

/** Region claims reaching this sink — read-only here, authored on the region. */
function InheritedLaw({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const inherited = useMemo(
    () =>
      effectiveClaimsStack(doc, node.id).filter(
        (entry) => entry.provenance.kind === "region",
      ),
    [doc, node.id],
  );
  if (inherited.length === 0) return null;

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">inherited law</div>
      <div className="inspector-detail mt-1">
        From the regions holding this sink. Edit them on the region.
      </div>
      <div className="mt-2 grid gap-1.5" role="list">
        {inherited.map((entry, index) => (
          <div
            key={`${entry.claim.id}:${index}`}
            role="listitem"
            className="rounded-[4px] border border-stroke bg-inset/50 px-2 py-1.5"
          >
            <div className="text-[11px] leading-snug text-ink">{entry.claim.text}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              <Chip tone={entry.claim.severity === "hard" ? "amber" : "steel"}>
                {entry.claim.severity}
              </Chip>
              {entry.provenance.kind === "region" ? (
                <Chip tone="violet">region {entry.provenance.label}</Chip>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BakeTimeField({
  claimableAfterMs,
  resetKey,
  onCommit,
}: {
  readonly claimableAfterMs: number | undefined;
  readonly resetKey: string;
  readonly onCommit: (ms: number | undefined) => void;
}) {
  const stored = formatBakeTime(claimableAfterMs);
  const [draft, setDraft] = useState(stored);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(stored);
    setInvalid(false);
  }, [resetKey, stored]);

  const commit = () => {
    const parsed = parseBakeTime(draft);
    if (!parsed.ok) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(formatBakeTime(parsed.ms));
    if (parsed.ms !== claimableAfterMs) onCommit(parsed.ms);
  };

  return (
    <label className="inspector-editor">
      <span>bake time</span>
      <input
        data-focus-owner="canvas-draft"
        aria-label="Bake time before an arrival is claimable"
        value={draft}
        placeholder="e.g. 90m, 12h, 7d"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setDraft(stored);
            setInvalid(false);
            event.currentTarget.blur();
          }
        }}
      />
      <span className="inspector-detail normal-case tracking-normal">
        {invalid
          ? "Use a duration like 90m, 12h, or 7d. Empty means claimable on arrival."
          : "How long an arrival waits before any seat may be assigned it."}
      </span>
    </label>
  );
}

export function SinkContractEditor({
  node,
  focusSide,
}: {
  readonly node: CanvasNode;
  /** Board-side entry opens only the matching half of the station contract. */
  readonly focusSide?: "inbound" | "outbound";
}) {
  const [openFolds, setOpenFolds] = useState(() => openFoldsFor(focusSide));
  useEffect(() => {
    setOpenFolds(openFoldsFor(focusSide));
  }, [focusSide, node.id]);

  if (node.ether?.entity?.kind !== "task") return null;

  const contract = node.ether?.tasks?.contract;
  const claims = contract?.claims ?? [];
  const inbound = contract?.inbound;
  const outbound = contract?.outbound;
  const admission = resolveSinkAdmission(contract);

  const write = (next: TasksSinkContract) =>
    setSinkContract(node.id, normalizeSinkContract(next));
  const writeInbound = (next: TasksInboundContract) =>
    write({ ...contract, inbound: { ...inbound, ...next } });
  const writeOutbound = (next: TasksOutboundContract) =>
    write({ ...contract, outbound: { ...outbound, ...next } });

  const bake = formatBakeTime(inbound?.claimableAfterMs);
  const inboundSummary = [
    admissionLabel(admission),
    bake ? `bakes ${bake}` : undefined,
    inbound?.checklist?.length ? `${inbound.checklist.length} checks` : undefined,
  ]
    .filter(Boolean)
    .join(", ");
  const outboundSummary =
    [
      outbound?.emission?.trim() ? "emission set" : undefined,
      outbound?.checklist?.length ? `${outbound.checklist.length} checks` : undefined,
    ]
      .filter(Boolean)
      .join(", ") || "nothing set";

  const inboundFold = (
    <Fold
      title="arrivals"
      summary={inboundSummary}
      open={openFolds.inbound}
      onToggle={() =>
        setOpenFolds((open) => ({ ...open, inbound: !open.inbound }))
      }
      >
        <label className="inspector-editor">
          <span>admission</span>
          <Select
            dense
            aria-label="How arrivals become claimable"
            value={admission}
            options={ADMISSION_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
            onChange={(next) => writeInbound({ admission: next as SinkAdmission })}
          />
        </label>
        <BakeTimeField
          claimableAfterMs={inbound?.claimableAfterMs}
          resetKey={node.id}
          onCommit={(ms) => writeInbound({ claimableAfterMs: ms })}
        />
        <ContractText
          label="triage"
          ariaLabel="Sink inbound instruction"
          resetKey={node.id}
          value={inbound?.instruction ?? ""}
          placeholder="How should arrivals be handled here?"
          onCommit={(instruction) => writeInbound({ instruction })}
        />
        <ContractText
          label="description"
          hint="Read by upstream stations choosing where to forward."
          ariaLabel="Sink inbound description"
          resetKey={node.id}
          value={inbound?.description ?? ""}
          placeholder="What this station takes in."
          onCommit={(description) => writeInbound({ description })}
        />
        <CheckList
          ownerKey={`${node.id}:inbound`}
          checklist={inbound?.checklist ?? []}
          hint="Run by the seat on boarding an arrival here."
          onChange={(checklist: ReadonlyArray<CheckDef>) => writeInbound({ checklist })}
        />
      </Fold>
  );
  const outboundFold = (
    <Fold
      title="departures"
      summary={outboundSummary}
      open={openFolds.outbound}
      onToggle={() =>
        setOpenFolds((open) => ({ ...open, outbound: !open.outbound }))
      }
      >
        <ContractText
          label="emission"
          hint="What a seat publishes forward when it hands the task on."
          ariaLabel="Sink outbound emission"
          resetKey={node.id}
          value={outbound?.emission ?? ""}
          placeholder="What must travel with the task from here?"
          onCommit={(emission) => writeOutbound({ emission })}
        />
        <ContractText
          label="description"
          ariaLabel="Sink outbound description"
          resetKey={node.id}
          value={outbound?.description ?? ""}
          placeholder="What this station sends on."
          onCommit={(description) => writeOutbound({ description })}
        />
        <CheckList
          ownerKey={`${node.id}:outbound`}
          checklist={outbound?.checklist ?? []}
          hint="Run by the seat before the task leaves this station."
          onChange={(checklist: ReadonlyArray<CheckDef>) => writeOutbound({ checklist })}
        />
      </Fold>
  );

  return (
    <>
      <ContractText
        label="stage"
        hint="Seats claiming here receive this as ambient context."
        ariaLabel="Sink stage instruction"
        resetKey={node.id}
        value={contract?.instruction ?? ""}
        placeholder="What is this stage for?"
        onCommit={(instruction) => write({ ...contract, instruction })}
      />

      <InheritedLaw node={node} />

      <ClaimList
        ownerNodeId={node.id}
        claims={claims}
        label="claims at this sink"
        hint="Answered by whoever closes a task here, on top of the region law above."
        onChange={(next: ReadonlyArray<ClaimDef>) => write({ ...contract, claims: next })}
      />

      {focusSide !== "outbound" ? inboundFold : null}
      {focusSide !== "inbound" ? outboundFold : null}
    </>
  );
}
