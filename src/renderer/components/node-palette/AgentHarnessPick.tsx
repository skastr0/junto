/**
 * Shared harness pick UI (palette agents column + agent re-seat).
 * One cascade menu + template list — do not fork harness rules.
 *
 * Listing rules (in order):
 *  1. compile-time feature gate (`managedHarnessEnabled` via allTemplates)
 *  2. local CLI install probe (main PATH + known install homes)
 *  3. Settings → Agents visibility
 * Never offer a harness that would spawn a broken/missing binary.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { use$ } from "@legendapp/state/react";
import {
  allTemplates,
  templateFor,
  type HarnessId,
  type ManagedTerminalTemplate,
} from "@shared/managed-terminal-templates";
import { harnessVisibleInPalette } from "@shared/harness-settings";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { state$ } from "../../lib/state";
import { rankMatches } from "../../lib/fuzzy-match";
import {
  typeaheadAccept,
  typeaheadIndex,
  type TypeaheadBuffer,
} from "../../lib/typeahead";
import { HarnessMark } from "../HarnessMark";
import type { AgentConfigurationChoices } from "./agent-launch-model";
import {
  AgentCascadeMenu,
  cascadeEnterKey,
  cascadeSideFor,
} from "./AgentCascadeMenu";

const TAB_CANDIDATES =
  'button, a[href], area[href], input, select, textarea, [tabindex], [contenteditable="true"]';

/** True when this dismisses an open cascade. Never restores row focus. */
export type CascadeDismiss = () => boolean;

export type AgentHarnessPickProps = {
  readonly onConfigure: (choices: AgentConfigurationChoices) => void;
  /** Optional filter over display names and harness ids. */
  readonly query?: string;
  readonly className?: string;
  readonly listLabel?: string;
  /** Highlight the current seat harness (re-seat). */
  readonly currentHarness?: HarnessId;
  readonly cascadeDismissRef?: MutableRefObject<CascadeDismiss | null>;
};

const isTabStop = (element: HTMLElement): boolean => {
  if (element.tabIndex < 0) return false;
  if (element.matches(":disabled")) return false;
  if (element.closest("[inert], [hidden]")) return false;
  if (element.getClientRects().length === 0) return false;
  const visibility = getComputedStyle(element).visibility;
  if (visibility === "hidden" || visibility === "collapse") return false;
  if (element.closest(".agent-cascade")) return false;
  return true;
};

const isPrintableKey = (event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean =>
  event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;

/**
 * Harness buttons + progressive cascade (model / effort / hermes profile).
 * Same rules as the node palette agents column.
 */
export function AgentHarnessPick({
  onConfigure,
  query = "",
  className,
  listLabel = "Agents",
  currentHarness,
  cascadeDismissRef,
}: AgentHarnessPickProps) {
  const settings = use$(state$.settings);
  const [agentCascade, setAgentCascade] = useState<{
    readonly harness: HarnessId;
    readonly anchor: HTMLButtonElement;
    readonly focusOnOpen: boolean;
  } | null>(null);
  const cascadeCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastQueryRef = useRef(query);
  const typeaheadRef = useRef<TypeaheadBuffer>({ text: "", at: 0 });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      if (cascadeCloseTimer.current) clearTimeout(cascadeCloseTimer.current);
    };
  }, []);

  const keepCascadeOpen = useCallback(() => {
    if (!cascadeCloseTimer.current) return;
    clearTimeout(cascadeCloseTimer.current);
    cascadeCloseTimer.current = null;
  }, []);
  const closeCascade = useCallback(() => {
    keepCascadeOpen();
    setAgentCascade(null);
  }, [keepCascadeOpen]);
  const closeCascadeSoon = useCallback(() => {
    keepCascadeOpen();
    cascadeCloseTimer.current = setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof Element && active.closest(".agent-cascade")) {
        return;
      }
      setAgentCascade(null);
    }, 140);
  }, [keepCascadeOpen]);
  const openCascade = useCallback(
    (harness: HarnessId, anchor: HTMLButtonElement, focusOnOpen = false) => {
      keepCascadeOpen();
      setAgentCascade({ harness, anchor, focusOnOpen });
    },
    [keepCascadeOpen],
  );
  const exitCascade = useCallback(() => {
    const anchor = agentCascade?.anchor;
    closeCascade();
    if (anchor?.isConnected) anchor.focus();
  }, [agentCascade?.anchor, closeCascade]);

  const tabExitCascade = useCallback(
    (delta: 1 | -1) => {
      const anchor = agentCascade?.anchor;
      closeCascade();
      if (!anchor?.isConnected) return;
      const owner =
        anchor.closest<HTMLElement>('[role="dialog"], [data-focus-surface]') ??
        document.documentElement;
      const candidates = Array.from(
        owner.querySelectorAll<HTMLElement>(TAB_CANDIDATES),
      ).filter(isTabStop);
      const index = candidates.indexOf(anchor);
      if (index < 0) {
        anchor.focus();
        return;
      }
      const next =
        candidates[(index + delta + candidates.length) % candidates.length];
      next?.focus();
    },
    [agentCascade?.anchor, closeCascade],
  );

  const configure = useCallback(
    (choices: AgentConfigurationChoices) => {
      closeCascade();
      onConfigure(choices);
    },
    [closeCascade, onConfigure],
  );

  useLayoutEffect(() => {
    if (!cascadeDismissRef) return;
    cascadeDismissRef.current = () => {
      if (!agentCascade) return false;
      closeCascade();
      return true;
    };
    return () => {
      cascadeDismissRef.current = null;
    };
  }, [agentCascade, cascadeDismissRef, closeCascade]);

  useEffect(() => {
    if (!agentCascade) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest(".agent-harness-pick")) {
        return;
      }
      const menu = document.querySelector(".agent-cascade");
      if (menu?.contains(target)) return;
      closeCascade();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [agentCascade, closeCascade]);

  /** Feature-enabled templates; install filter applied after probe. */
  const featureTemplates = useMemo(() => allTemplates(), []);
  const [installedHarnesses, setInstalledHarnesses] = useState<
    ReadonlySet<HarnessId> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    const api = getVellumCommandApi();
    if (!api?.managedTerminalHarnesses) {
      // No probe API (tests / degraded preload): fail closed — hide all until
      // we can prove install. Feature gate still applied via empty set.
      setInstalledHarnesses(new Set());
      return;
    }
    void api
      .managedTerminalHarnesses()
      .then((result) => {
        if (cancelled) return;
        const installed = new Set<HarnessId>();
        for (const row of result.harnesses) {
          if (row.installed) installed.add(row.harness as HarnessId);
        }
        setInstalledHarnesses(installed);
      })
      .catch(() => {
        if (!cancelled) setInstalledHarnesses(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const probing = installedHarnesses === null;
  const installedTemplates = useMemo(() => {
    if (installedHarnesses === null) return [] as readonly ManagedTerminalTemplate[];
    return featureTemplates.filter((template) =>
      installedHarnesses.has(template.harness),
    );
  }, [featureTemplates, installedHarnesses]);
  const eligibleTemplates = useMemo(
    () =>
      installedTemplates.filter((template) =>
        harnessVisibleInPalette(settings, template.harness),
      ),
    [installedTemplates, settings],
  );
  const matchingTemplates: readonly ManagedTerminalTemplate[] = useMemo(
    () =>
      rankMatches(eligibleTemplates, query, (template) => ({
        identity: [template.displayName, template.harness],
      })).map((row) => row.item),
    [eligibleTemplates, query],
  );

  useLayoutEffect(() => {
    if (lastQueryRef.current !== query) {
      lastQueryRef.current = query;
      typeaheadRef.current = { text: "", at: 0 };
      if (agentCascade) closeCascade();
      return;
    }
    if (!agentCascade) return;
    const stillVisible = matchingTemplates.some(
      (template) => template.harness === agentCascade.harness,
    );
    if (!stillVisible || !agentCascade.anchor.isConnected) closeCascade();
  }, [agentCascade, closeCascade, matchingTemplates, query]);

  const rowButtons = (): HTMLButtonElement[] =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(
        ".agent-harness-pick__item",
      ) ?? [],
    );

  const focusRow = (button: HTMLButtonElement): void => {
    button.focus();
    button.scrollIntoView({ block: "nearest" });
  };

  const emptyCopy = probing
    ? null
    : featureTemplates.length === 0
      ? "No agent harnesses enabled in this build."
      : installedTemplates.length === 0
        ? "No installed agent CLIs found on this machine."
        : eligibleTemplates.length === 0
          ? "All installed agents are hidden by Settings."
          : query.trim() && matchingTemplates.length === 0
            ? `No agents match "${query.trim()}".`
            : null;

  return (
    <div
      className={["agent-harness-pick", className ?? ""].filter(Boolean).join(" ")}
      aria-label={listLabel}
    >
      <div className="agent-harness-pick__list" role="list" ref={listRef}>
        {probing ? (
          <div className="agent-harness-pick__loading" role="status" aria-label="Detecting installed agents">
            Detecting installed agents…
          </div>
        ) : null}
        {emptyCopy ? (
          <div className="agent-harness-pick__empty" role="status">
            {emptyCopy}
          </div>
        ) : null}
        {matchingTemplates.map((template) => {
          const selected = agentCascade?.harness === template.harness;
          const current = currentHarness === template.harness;
          return (
            <div key={template.harness} role="listitem">
              <button
                type="button"
                className={[
                  "agent-harness-pick__item",
                  selected ? "is-expanded" : "",
                  current ? "is-current" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={`${current ? "Current " : ""}${template.displayName}`}
                aria-haspopup="menu"
                aria-expanded={selected}
                onMouseEnter={(event) =>
                  openCascade(template.harness, event.currentTarget)
                }
                onMouseLeave={closeCascadeSoon}
                onBlur={closeCascadeSoon}
                onKeyDown={(event) => {
                  const composing =
                    event.nativeEvent.isComposing || event.key === "Process";
                  if (composing) return;

                  if (event.key === "Tab") {
                    closeCascade();
                    return;
                  }

                  if (event.key === "Escape") {
                    if (!agentCascade) return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeCascade();
                    return;
                  }

                  const enterKey = cascadeEnterKey(
                    cascadeSideFor(event.currentTarget),
                  );
                  if (
                    event.key === "Enter" ||
                    event.key === " " ||
                    event.key === enterKey
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    typeaheadRef.current = { text: "", at: 0 };
                    openCascade(template.harness, event.currentTarget, true);
                    return;
                  }

                  const rows = rowButtons();
                  const index = rows.indexOf(event.currentTarget);
                  const moveTo = (next: number): void => {
                    const target = rows[next];
                    if (!target) return;
                    event.preventDefault();
                    typeaheadRef.current = { text: "", at: 0 };
                    if (agentCascade) closeCascade();
                    focusRow(target);
                  };

                  if (event.key === "ArrowDown") {
                    moveTo(Math.min(index + 1, rows.length - 1));
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    moveTo(Math.max(index - 1, 0));
                    return;
                  }
                  if (event.key === "Home") {
                    moveTo(0);
                    return;
                  }
                  if (event.key === "End") {
                    moveTo(rows.length - 1);
                    return;
                  }

                  if (!isPrintableKey(event) || event.key === " ") return;
                  event.preventDefault();
                  typeaheadRef.current = typeaheadAccept(
                    typeaheadRef.current,
                    event.key,
                    Date.now(),
                  );
                  const labels = rows.map(
                    (row) => row.getAttribute("aria-label") ?? "",
                  );
                  const next = typeaheadIndex(
                    labels,
                    typeaheadRef.current.text,
                    index,
                  );
                  if (next === null) return;
                  const target = rows[next];
                  if (!target) return;
                  if (agentCascade && target !== event.currentTarget) {
                    closeCascade();
                  }
                  focusRow(target);
                }}
                onClick={() => configure({ harness: template.harness })}
              >
                <HarnessMark
                  agent={template.harness}
                  size={28}
                  title={false}
                  treatment="neutral"
                />
                <strong>{template.displayName}</strong>
                {current ? <span className="agent-harness-pick__current">current</span> : null}
              </button>
            </div>
          );
        })}
      </div>
      {agentCascade ? (
        <AgentCascadeMenu
          key={agentCascade.harness}
          harness={agentCascade.harness}
          anchor={agentCascade.anchor}
          focusOnOpen={agentCascade.focusOnOpen}
          onConfigure={configure}
          onPointerEnter={keepCascadeOpen}
          onPointerLeave={closeCascadeSoon}
          onExit={exitCascade}
          onTabExit={tabExitCascade}
        />
      ) : null}
    </div>
  );
}

/** Re-export for callers that only need the type. */
export type { AgentConfigurationChoices };
export { templateFor };
