/**
 * Shared harness pick UI (palette agents column + agent re-seat).
 * One cascade menu + template list — do not fork harness rules.
 *
 * Listing rules (in order):
 *  1. compile-time feature gate (`managedHarnessEnabled` via allTemplates)
 *  2. local CLI install probe (main PATH + known install homes)
 * Never offer a harness that would spawn a broken/missing binary.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  allTemplates,
  templateFor,
  type HarnessId,
  type ManagedTerminalTemplate,
} from "@shared/managed-terminal-templates";
import { harnessVisibleInPalette } from "@shared/harness-settings";
import { getVellumCommandApi } from "../../lib/vellum-api";
import { state$ } from "../../lib/state";
import { HarnessMark } from "../HarnessMark";
import type { AgentConfigurationChoices } from "./agent-launch-model";
import { AgentCascadeMenu } from "./AgentCascadeMenu";

const cascadeEnterKey = (side: "end" | "start"): string =>
  side === "end" ? "ArrowRight" : "ArrowLeft";

const cascadeSideFor = (anchor: HTMLElement): "end" | "start" => {
  const rect = anchor.getBoundingClientRect();
  const roomEnd = window.innerWidth - rect.right;
  const roomStart = rect.left;
  return roomEnd >= roomStart ? "end" : "start";
};

export type AgentHarnessPickProps = {
  readonly onConfigure: (choices: AgentConfigurationChoices) => void;
  /** Optional filter over display names. */
  readonly query?: string;
  readonly className?: string;
  readonly listLabel?: string;
  /** Highlight the current seat harness (re-seat). */
  readonly currentHarness?: HarnessId;
};

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
}: AgentHarnessPickProps) {
  const [agentCascade, setAgentCascade] = useState<{
    readonly harness: HarnessId;
    readonly anchor: HTMLButtonElement;
    readonly focusOnOpen: boolean;
  } | null>(null);
  const cascadeCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (
        active instanceof Element &&
        active.closest(".agent-cascade, .agent-harness-pick")
      ) {
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
    requestAnimationFrame(() => {
      if (anchor?.isConnected) anchor.focus();
    });
  }, [agentCascade?.anchor, closeCascade]);

  const configure = useCallback(
    (choices: AgentConfigurationChoices) => {
      closeCascade();
      onConfigure(choices);
    },
    [closeCascade, onConfigure],
  );

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

  const matchingTemplates: readonly ManagedTerminalTemplate[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const settings = state$.settings.get();
    return featureTemplates.filter((template) => {
      if (installedHarnesses !== null && !installedHarnesses.has(template.harness)) {
        return false;
      }
      // While probe is in flight, show nothing (avoid flash of uninstalled rows).
      if (installedHarnesses === null) return false;
      // Settings → Agents user opt-out (when harnessSettings feature is live).
      if (!harnessVisibleInPalette(settings, template.harness)) return false;
      if (!q) return true;
      return template.displayName.toLowerCase().includes(q);
    });
  }, [featureTemplates, installedHarnesses, query]);

  return (
    <div
      className={["agent-harness-pick", className ?? ""].filter(Boolean).join(" ")}
      aria-label={listLabel}
    >
      <div className="agent-harness-pick__list" role="list">
        {installedHarnesses === null ? (
          <div className="agent-harness-pick__loading" role="status" aria-label="Detecting installed agents">
            Detecting installed agents…
          </div>
        ) : null}
        {installedHarnesses !== null && matchingTemplates.length === 0 ? (
          <div className="agent-harness-pick__empty" role="status">
            {featureTemplates.length === 0
              ? "No agent harnesses enabled in this build."
              : "No installed agent CLIs found on this machine."}
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
                onFocus={(event) =>
                  openCascade(template.harness, event.currentTarget)
                }
                onBlur={closeCascadeSoon}
                onMouseEnter={(event) =>
                  openCascade(template.harness, event.currentTarget)
                }
                onMouseLeave={closeCascadeSoon}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" ||
                    event.key === cascadeEnterKey(cascadeSideFor(event.currentTarget))
                  ) {
                    event.preventDefault();
                    openCascade(template.harness, event.currentTarget, true);
                  }
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
        />
      ) : null}
    </div>
  );
}

/** Re-export for callers that only need the type. */
export type { AgentConfigurationChoices };
export { templateFor };
