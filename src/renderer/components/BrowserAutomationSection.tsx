import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "@shared/canvas";
import type {
  BrowserAutomationHerdrAgent,
  BrowserAutomationSummary,
  VellumBrowserAutomationApi,
} from "@shared/ipc";
import { DIM, HUE, INK, withAlpha } from "../lib/theme";
import { getVellumApi } from "../lib/vellum-api";
import {
  BROWSER_AUTOMATION_AGENT_OPTIONS,
  boundedBrowserAutomationText,
  browserAutomationEligibility,
  browserAutomationEligibilityCopy,
  browserAutomationFailureNotice,
  browserAutomationNodeRef,
  buildBrowserAutomationEnableInput,
  isCurrentBrowserAutomationGrant,
  isBrowserAutomationHerdrAgent,
  type BrowserAutomationUiNotice,
} from "../lib/browser-automation-ui";

type AutomationApi = ReturnType<typeof getVellumApi> &
  Partial<VellumBrowserAutomationApi>;

interface RequestToken {
  readonly epoch: number;
  readonly id: symbol;
}

const defaultHerdrAgent: BrowserAutomationHerdrAgent = "codex";

const requestToken = (epoch: number): RequestToken => ({
  epoch,
  id: Symbol("browser-automation-request"),
});

const sameToken = (
  left: RequestToken | undefined,
  right: RequestToken,
): boolean => left?.epoch === right.epoch && left.id === right.id;

const upsertGrant = (
  current: ReadonlyArray<BrowserAutomationSummary>,
  next: BrowserAutomationSummary,
): ReadonlyArray<BrowserAutomationSummary> => [
  next,
  ...current.filter((grant) => grant.automationId !== next.automationId),
];

export function BrowserAutomationSection({
  canvasName,
  node,
}: {
  readonly canvasName: string;
  readonly node: CanvasNode;
}) {
  const selectionKey = `${canvasName}\u0000${node.id}`;
  const selectionKeyRef = useRef(selectionKey);
  const selectionEpochRef = useRef(0);
  if (selectionKeyRef.current !== selectionKey) {
    selectionKeyRef.current = selectionKey;
    selectionEpochRef.current += 1;
  }

  const [grants, setGrants] = useState<ReadonlyArray<BrowserAutomationSummary>>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState<BrowserAutomationUiNotice | undefined>();
  const [enablePending, setEnablePending] = useState(false);
  const [revokingIds, setRevokingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [herdrAgent, setHerdrAgent] =
    useState<BrowserAutomationHerdrAgent>(defaultHerdrAgent);

  const listedEpochRef = useRef<number | undefined>(undefined);
  const listRequestRef = useRef<RequestToken | undefined>(undefined);
  const enableRequestRef = useRef<RequestToken | undefined>(undefined);
  const revokeRequestRef = useRef<Map<string, RequestToken>>(new Map());
  const eligibility = browserAutomationEligibility(node);
  const currentRef = browserAutomationNodeRef(canvasName, node);

  const refreshList = async (epoch: number): Promise<void> => {
    if (selectionEpochRef.current !== epoch) return;
    const active = listRequestRef.current;
    if (active?.epoch === epoch) return;
    const token = requestToken(epoch);
    listRequestRef.current = token;
    if (listedEpochRef.current !== epoch) setListState("loading");

    try {
      const api = getVellumApi() as AutomationApi | undefined;
      if (typeof api?.browserAutomationList !== "function") {
        throw new Error("bridge unavailable");
      }
      const result = await api.browserAutomationList();
      if (selectionEpochRef.current !== epoch || !sameToken(listRequestRef.current, token)) {
        return;
      }
      if (!result.ok) {
        if (listedEpochRef.current !== epoch) setListState("failed");
        setNotice(browserAutomationFailureNotice("list", result.code));
        return;
      }
      listedEpochRef.current = epoch;
      setGrants(result.data);
      setListState("ready");
      setNotice(undefined);
    } catch {
      if (selectionEpochRef.current !== epoch || !sameToken(listRequestRef.current, token)) {
        return;
      }
      if (listedEpochRef.current !== epoch) setListState("failed");
      setNotice(browserAutomationFailureNotice("list", "delivery_failed"));
    } finally {
      if (sameToken(listRequestRef.current, token)) listRequestRef.current = undefined;
    }
  };

  useEffect(() => {
    const epoch = selectionEpochRef.current;
    listedEpochRef.current = undefined;
    setGrants([]);
    setListState("loading");
    setNotice(undefined);
    setEnablePending(false);
    setRevokingIds(new Set());
    setHerdrAgent(defaultHerdrAgent);
    void refreshList(epoch);
  }, [selectionKey]);

  useEffect(
    () => () => {
      selectionEpochRef.current += 1;
    },
    [],
  );

  const enable = async (): Promise<void> => {
    const epoch = selectionEpochRef.current;
    if (
      listedEpochRef.current !== epoch ||
      enableRequestRef.current?.epoch === epoch
    ) {
      return;
    }
    const input = buildBrowserAutomationEnableInput({
      canvasName,
      node,
      ...(eligibility.eligible && eligibility.kind === "herdr"
        ? { agent: herdrAgent }
        : {}),
    });
    if (input === undefined) {
      setNotice({
        text: browserAutomationEligibilityCopy("invalid_ref"),
        tone: "error",
      });
      return;
    }

    const token = requestToken(epoch);
    enableRequestRef.current = token;
    setEnablePending(true);
    setNotice(undefined);
    try {
      const api = getVellumApi() as AutomationApi | undefined;
      if (typeof api?.browserAutomationEnable !== "function") {
        throw new Error("bridge unavailable");
      }
      const result = await api.browserAutomationEnable(input);
      if (selectionEpochRef.current !== epoch || !sameToken(enableRequestRef.current, token)) {
        return;
      }
      if (!result.ok) {
        setNotice(browserAutomationFailureNotice("enable", result.code));
        return;
      }
      setGrants((current) => upsertGrant(current, result.data));
      void refreshList(epoch);
    } catch {
      if (selectionEpochRef.current !== epoch || !sameToken(enableRequestRef.current, token)) {
        return;
      }
      setNotice(browserAutomationFailureNotice("enable", "delivery_failed"));
    } finally {
      if (sameToken(enableRequestRef.current, token)) {
        enableRequestRef.current = undefined;
        if (selectionEpochRef.current === epoch) setEnablePending(false);
      }
    }
  };

  const revoke = async (grant: BrowserAutomationSummary): Promise<void> => {
    const epoch = selectionEpochRef.current;
    if (
      listedEpochRef.current !== epoch ||
      revokeRequestRef.current.get(grant.automationId)?.epoch === epoch
    ) {
      return;
    }
    const token = requestToken(epoch);
    revokeRequestRef.current.set(grant.automationId, token);
    setRevokingIds((current) => new Set([...current, grant.automationId]));
    setNotice(undefined);
    try {
      const api = getVellumApi() as AutomationApi | undefined;
      if (typeof api?.browserAutomationRevoke !== "function") {
        throw new Error("bridge unavailable");
      }
      const result = await api.browserAutomationRevoke(grant.automationId);
      if (
        selectionEpochRef.current !== epoch ||
        !sameToken(revokeRequestRef.current.get(grant.automationId), token)
      ) {
        return;
      }
      if (!result.ok) {
        if (result.code === "not_found") {
          setGrants((current) =>
            current.filter((candidate) => candidate.automationId !== grant.automationId),
          );
          setNotice(undefined);
          return;
        }
        setNotice(browserAutomationFailureNotice("revoke", result.code));
        return;
      }
      setGrants((current) =>
        current.filter((candidate) => candidate.automationId !== grant.automationId),
      );
      void refreshList(epoch);
    } catch {
      if (
        selectionEpochRef.current !== epoch ||
        !sameToken(revokeRequestRef.current.get(grant.automationId), token)
      ) {
        return;
      }
      setNotice(browserAutomationFailureNotice("revoke", "delivery_failed"));
    } finally {
      if (sameToken(revokeRequestRef.current.get(grant.automationId), token)) {
        revokeRequestRef.current.delete(grant.automationId);
        if (selectionEpochRef.current === epoch) {
          setRevokingIds((current) => {
            const next = new Set(current);
            next.delete(grant.automationId);
            return next;
          });
        }
      }
    }
  };

  const ready = listedEpochRef.current === selectionEpochRef.current;
  const enableDisabled = !eligibility.eligible || !ready || enablePending;

  return (
    <div className="inspector-section">
      <div className="inspector-section__label">browser automation</div>
      <div className="mt-2 text-[10px] leading-relaxed" style={{ color: DIM }}>
        A native Vellum prompt shows the exact pages and limits before access starts.
      </div>

      {eligibility.eligible && eligibility.kind === "herdr" ? (
        <label className="mt-2 block text-[9px] uppercase tracking-[.12em]" style={{ color: DIM }}>
          local agent
          <select
            aria-label="Herdr browser automation agent"
            className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-[11px]"
            style={{ borderColor: "rgba(237,230,218,.14)", color: INK }}
            value={herdrAgent}
            disabled={!ready || enablePending}
            onChange={(event) => {
              const candidate = event.currentTarget.value;
              if (isBrowserAutomationHerdrAgent(candidate)) setHerdrAgent(candidate);
            }}
          >
            {BROWSER_AUTOMATION_AGENT_OPTIONS.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {eligibility.eligible ? (
        <button
          type="button"
          className="mt-2 w-full rounded-md border py-1.5 text-[9px] uppercase tracking-[.12em] transition disabled:cursor-not-allowed disabled:opacity-35"
          style={{
            borderColor: withAlpha(HUE.amber, 0.35),
            background: withAlpha(HUE.amber, 0.08),
            color: HUE.amber,
          }}
          disabled={enableDisabled}
          onClick={() => void enable()}
        >
          {enablePending ? "waiting for approval…" : "enable browser access"}
        </button>
      ) : (
        <div className="mt-2 text-[10px] leading-relaxed" style={{ color: DIM }}>
          {browserAutomationEligibilityCopy(eligibility.reason)}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-[.12em]" style={{ color: DIM }}>
          active access
        </span>
        {listState === "failed" ? (
          <button
            type="button"
            className="rounded-md border px-2 py-1 text-[9px] uppercase tracking-[.12em]"
            style={{ borderColor: "rgba(237,230,218,.14)", color: DIM }}
            onClick={() => void refreshList(selectionEpochRef.current)}
          >
            retry
          </button>
        ) : null}
      </div>

      {listState === "loading" ? (
        <div className="mt-2 text-[10px]" role="status" style={{ color: DIM }}>
          checking active access…
        </div>
      ) : null}
      {listState === "ready" && grants.length === 0 ? (
        <div className="mt-2 text-[10px]" style={{ color: DIM }}>
          no active grants
        </div>
      ) : null}
      {grants.length > 0 ? (
        <div className="inspector-bindings mt-2">
          {grants.map((grant) => {
            const revoking = revokingIds.has(grant.automationId);
            const current = isCurrentBrowserAutomationGrant(grant, currentRef);
            const subject = grant.kind === "herdr" ? `${grant.agent} · Herdr` : "Hermes";
            return (
              <div
                className="inspector-binding"
                key={grant.automationId}
                style={current ? { background: withAlpha(HUE.amber, 0.08) } : undefined}
              >
                <span className="inspector-binding__source">
                  {subject}{current ? " · current" : ""}
                </span>
                <span title={boundedBrowserAutomationText(grant.ref)}>
                  {boundedBrowserAutomationText(grant.ref, 160)}
                </span>
                <button
                  type="button"
                  className="rounded border px-1.5 py-0.5 text-[8px] uppercase tracking-[.1em] disabled:opacity-35"
                  style={{ borderColor: withAlpha(HUE.crimson, 0.35), color: HUE.crimson }}
                  disabled={!ready || revoking}
                  title={`expires ${new Date(grant.expiresAt).toLocaleString()}`}
                  onClick={() => void revoke(grant)}
                >
                  {revoking ? "revoking…" : "revoke"}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {notice ? (
        <div
          className="mt-2 text-[10px] leading-relaxed"
          style={{
            color:
              notice.tone === "neutral" ? DIM : withAlpha(HUE.crimson, 0.78),
          }}
        >
          {boundedBrowserAutomationText(notice.text)}
        </div>
      ) : null}
    </div>
  );
}
