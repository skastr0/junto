import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import {
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";
import type {
  ManagedTerminalModelOption,
  ManagedTerminalProfileOption,
} from "@shared/ipc";
import { getJuntoApi } from "../../lib/junto-api";
import {
  typeaheadAccept,
  typeaheadIndex,
  type TypeaheadBuffer,
} from "../../lib/typeahead";
import {
  firstCascadeColumn,
  type AgentConfigurationChoices,
} from "./agent-launch-model";
import { claimFocus } from "../../lib/focus-ownership";

export type { AgentConfigurationChoices };

type CascadeSide = "end" | "start";

type CascadePosition =
  | { readonly top: number; readonly left: number; readonly flexDirection: "row" }
  | { readonly top: number; readonly right: number; readonly flexDirection: "row-reverse" };

type CascadeStep = "profile" | "model" | "effort";

const MENU_WIDTH = 184;
const MENU_GAP = 3;
const MENU_MAX_HEIGHT = 288;
/** Edge margin so the cascade never kisses the viewport. */
const VIEWPORT_PAD = 8;
/**
 * Max progressive columns for side selection (profile → model → effort).
 * Side is chosen against this width once so opening a sub-column never flips
 * the cascade under the pointer (right → left jump).
 */
const MAX_CASCADE_COLUMNS = 3;

const DEFAULTS_LABEL = "Use harness defaults";

const cascadeWidth = (columnCount: number): number =>
  columnCount * MENU_WIDTH + Math.max(0, columnCount - 1) * MENU_GAP;

/** Prefer the end (right of LTR anchor). Only flip when max width will not fit. */
const sideFor = (anchor: HTMLElement, reserveColumns: number): CascadeSide => {
  const rect = anchor.getBoundingClientRect();
  const roomEnd = window.innerWidth - rect.right - VIEWPORT_PAD;
  return roomEnd >= cascadeWidth(reserveColumns) ? "end" : "start";
};

/**
 * Which horizontal side the cascade will occupy relative to the palette row.
 * Keyboard arrows follow this side so → always moves visually right, never
 * "deeper" against the layout when the menu is mirrored.
 */
export const cascadeSideFor = (anchor: HTMLElement): CascadeSide =>
  sideFor(anchor, MAX_CASCADE_COLUMNS);

/** Arrow key that steps deeper into the cascade (toward nested columns). */
export const cascadeEnterKey = (side: CascadeSide): "ArrowRight" | "ArrowLeft" =>
  side === "end" ? "ArrowRight" : "ArrowLeft";

/** Arrow key that retreats toward the palette / parent column. */
export const cascadeRetreatKey = (side: CascadeSide): "ArrowRight" | "ArrowLeft" =>
  side === "end" ? "ArrowLeft" : "ArrowRight";

const positionFor = (
  anchor: HTMLElement,
  side: CascadeSide,
): CascadePosition => {
  const rect = anchor.getBoundingClientRect();
  const top = Math.max(
    VIEWPORT_PAD,
    Math.min(rect.top - 5, window.innerHeight - MENU_MAX_HEIGHT - VIEWPORT_PAD),
  );
  if (side === "end") {
    return { top, left: rect.right + MENU_GAP, flexDirection: "row" };
  }
  return {
    top,
    right: window.innerWidth - rect.left + MENU_GAP,
    flexDirection: "row-reverse",
  };
};

const menuitemsIn = (column: Element): HTMLButtonElement[] =>
  Array.from(column.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));

const focusItem = (item: HTMLButtonElement | undefined): boolean => {
  if (!item) return false;
  claimFocus(item, "gesture");
  item.scrollIntoView({ block: "nearest" });
  return true;
};

const focusFirstInColumn = (column: Element | null | undefined): boolean => {
  const first = column ? menuitemsIn(column)[0] : undefined;
  return focusItem(first);
};

const focusExpandedOrFirst = (column: Element | null | undefined): boolean => {
  if (!column) return false;
  const expanded = column.querySelector<HTMLButtonElement>(
    '[role="menuitem"][aria-expanded="true"]',
  );
  if (expanded) return focusItem(expanded);
  return focusFirstInColumn(column);
};

const isPrintableKey = (event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean =>
  event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;

function LoadingRows() {
  return (
    <div className="agent-cascade__loading" aria-label="Loading options" role="status">
      <i />
      <i />
      <i />
    </div>
  );
}

/**
 * One cascade column. The caption is what the column is choosing (`model`,
 * `effort`) qualified by the step that opened it, so a column read on its own
 * still says which harness or model it belongs to.
 */
function MenuColumn({
  label,
  step,
  parent,
  children,
}: {
  readonly label: string;
  readonly step: CascadeStep;
  readonly parent: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="agent-cascade__column" data-cascade-step={step}>
      <div className="agent-cascade__caption" aria-hidden>
        <span className="agent-cascade__caption-parent">{parent}</span>
        <span className="agent-cascade__caption-step">{step}</span>
      </div>
      <div
        className="agent-cascade__items"
        role="menu"
        aria-label={label}
        data-cascade-step={step}
      >
        {children}
      </div>
    </div>
  );
}

function CascadeItem({
  label,
  expanded,
  onEnter,
  onSelect,
  skipExpandRef,
}: {
  readonly label: string;
  readonly expanded?: boolean;
  readonly onEnter?: () => void;
  readonly onSelect: () => void;
  readonly skipExpandRef: { current: boolean };
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      onMouseEnter={onEnter}
      onFocus={() => {
        if (skipExpandRef.current) return;
        onEnter?.();
      }}
      onClick={onSelect}
    >
      <span>{label}</span>
      {expanded === undefined ? null : <ChevronRight size={12} aria-hidden />}
    </button>
  );
}

export function AgentCascadeMenu({
  harness,
  anchor,
  onConfigure,
  onPointerEnter,
  onPointerLeave,
  /** Keyboard entry: focus the first menuitem once the first column is ready. */
  focusOnOpen = false,
  /** Leave the cascade (ArrowLeft / Escape from the first column) — parent restores palette focus. */
  onExit,
  onTabExit,
}: {
  readonly harness: HarnessId;
  readonly anchor: HTMLElement;
  readonly onConfigure: (choices: AgentConfigurationChoices) => void;
  readonly onPointerEnter: () => void;
  readonly onPointerLeave: () => void;
  readonly focusOnOpen?: boolean;
  readonly onExit?: () => void;
  readonly onTabExit?: (delta: 1 | -1) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef(focusOnOpen);
  /** ArrowRight may open a column that does not exist until the next render. */
  const pendingEnterStepRef = useRef<CascadeStep | null>(null);
  const typeaheadRef = useRef<TypeaheadBuffer>({ text: "", at: 0 });
  const typeaheadStepRef = useRef<CascadeStep | null>(null);
  /** Retreat focus must not re-open the child column via onFocus. */
  const skipExpandOnFocusRef = useRef(false);
  const [models, setModels] = useState<readonly ManagedTerminalModelOption[] | null>(null);
  const [profiles, setProfiles] = useState<readonly ManagedTerminalProfileOption[] | null>(
    harness === "hermes" ? null : [],
  );
  const [enumeratedEfforts, setEnumeratedEfforts] = useState<readonly string[]>([]);
  const [activeProfile, setActiveProfile] = useState<ManagedTerminalProfileOption | null>(null);
  const [activeModel, setActiveModel] = useState<ManagedTerminalModelOption | null>(null);
  // Lock open-side once so growing sub-columns never re-anchor under the cursor.
  const sideRef = useRef<CascadeSide | null>(null);
  const [position, setPosition] = useState<CascadePosition>(() => {
    const side = sideFor(anchor, MAX_CASCADE_COLUMNS);
    sideRef.current = side;
    return positionFor(anchor, side);
  });

  const resetTypeahead = (): void => {
    typeaheadRef.current = { text: "", at: 0 };
    typeaheadStepRef.current = null;
  };

  useEffect(() => {
    pendingFocusRef.current = focusOnOpen;
  }, [focusOnOpen, harness]);

  useEffect(() => {
    let live = true;
    const api = getJuntoApi();
    void api
      ?.managedTerminalModels?.(harness)
      .then((result) => {
        if (!live) return;
        setModels(result.models);
        setEnumeratedEfforts(result.efforts);
      })
      .catch(() => {
        if (live) setModels([]);
      });
    if (!api?.managedTerminalModels) setModels([]);

    if (harness === "hermes") {
      void api
        ?.managedTerminalProfiles?.()
        .then((result) => {
          if (live) setProfiles(result.profiles);
        })
        .catch(() => {
          if (live) setProfiles([]);
        });
      if (!api?.managedTerminalProfiles) setProfiles([]);
    }
    return () => {
      live = false;
    };
  }, [harness]);

  const efforts = useMemo(() => {
    if (!activeModel) return [] as readonly string[];
    if (activeModel.efforts?.length) return activeModel.efforts;
    if (enumeratedEfforts.length) return enumeratedEfforts;
    return templateFor(harness).efforts;
  }, [activeModel, enumeratedEfforts, harness]);

  const showModelColumn =
    harness === "hermes" && activeProfile !== null && (models === null || models.length > 0);
  const showEffortColumn = activeModel !== null && efforts.length > 0;

  useLayoutEffect(() => {
    const update = (rechooseSide: boolean) => {
      if (rechooseSide || sideRef.current === null) {
        sideRef.current = sideFor(anchor, MAX_CASCADE_COLUMNS);
      }
      setPosition(positionFor(anchor, sideRef.current));
    };
    update(false);
    const onResize = () => update(true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [anchor]);

  const profileChoices = profiles ?? [];
  // Hermes: pin the profile's configured model to the top of the second column
  // so hover→pick stays one glance away from "use profile default".
  const modelChoices = useMemo(() => {
    const base = models ?? [];
    if (harness !== "hermes" || !activeProfile?.model) return base;
    const pin = activeProfile.model;
    const rest = base.filter((m) => m.id !== pin);
    const pinned = base.find((m) => m.id === pin) ?? { id: pin, label: pin };
    return [pinned, ...rest];
  }, [models, harness, activeProfile]);
  /**
   * Some harnesses have no model to choose — their one dial is a named mode
   * (Amp `-m low|medium|high|ultra`, which selects model, system prompt, and
   * tools together). Those list modes in the first column, labelled as modes
   * and committed as `mode`, so nothing calls a mode a model.
   */
  const firstColumn = firstCascadeColumn(harness);
  const templateModes = firstColumn.kind === "modes" ? firstColumn.modes : [];
  const usesModes = firstColumn.kind === "modes";
  const firstColumnIsLoading = usesModes
    ? false
    : harness === "hermes"
      ? profiles === null
      : models === null;
  const configure = (choices: AgentConfigurationChoices): void => {
    onConfigure(choices);
  };

  // Keyboard entry waits for the first column to finish loading, then focuses
  // the first menuitem. Pointer hover leaves focus on the palette filter.
  // Late enumeration must not steal focus that has already left the anchor.
  useEffect(() => {
    if (!pendingFocusRef.current || firstColumnIsLoading) return;
    if (document.activeElement !== anchor) {
      pendingFocusRef.current = false;
      return;
    }
    const focused = focusFirstInColumn(
      rootRef.current?.querySelector(".agent-cascade__items"),
    );
    if (focused) pendingFocusRef.current = false;
  }, [anchor, firstColumnIsLoading, profileChoices, modelChoices, focusOnOpen]);

  const columnByStep = (step: CascadeStep): Element | null =>
    rootRef.current?.querySelector(`.agent-cascade__items[data-cascade-step="${step}"]`) ??
    null;

  // Fulfill ArrowRight into a column that appeared after state expanded.
  useLayoutEffect(() => {
    const step = pendingEnterStepRef.current;
    if (!step) return;
    const root = rootRef.current;
    const active = document.activeElement;
    if (!root || !(active instanceof Node) || !root.contains(active)) {
      pendingEnterStepRef.current = null;
      return;
    }
    if (focusFirstInColumn(columnByStep(step))) {
      pendingEnterStepRef.current = null;
    }
  }, [showModelColumn, showEffortColumn, activeModel, activeProfile, modelChoices, efforts]);

  const stepOf = (column: Element): CascadeStep | null => {
    const step = column.getAttribute("data-cascade-step");
    return step === "profile" || step === "model" || step === "effort" ? step : null;
  };

  const exitCascade = (): void => {
    resetTypeahead();
    onExit?.();
  };

  const onCascadeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const composing = event.nativeEvent.isComposing || event.key === "Process";
    if (composing) return;

    if (event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      pendingEnterStepRef.current = null;
      pendingFocusRef.current = false;
      onTabExit?.(event.shiftKey ? -1 : 1);
      return;
    }

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const column = target.closest(".agent-cascade__items");
    if (!(column instanceof Element)) return;

    const items = menuitemsIn(column);
    const index = items.indexOf(target as HTMLButtonElement);
    if (index < 0) return;

    const columnStep = stepOf(column);
    if (typeaheadStepRef.current !== columnStep) {
      typeaheadRef.current = { text: "", at: 0 };
      typeaheadStepRef.current = columnStep;
    }

    const focusAt = (next: number): void => {
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      typeaheadStepRef.current = columnStep;
      focusItem(items[next]);
    };

    // Horizontal arrows follow visual layout: when the cascade mirrors to the
    // start side (row-reverse), deeper columns sit to the LEFT of the parent.
    const side = sideRef.current ?? "end";
    const enterKey = cascadeEnterKey(side);
    const retreatKey = cascadeRetreatKey(side);

    const focusParentColumn = (parentStep: CascadeStep, label?: string): void => {
      skipExpandOnFocusRef.current = true;
      requestAnimationFrame(() => {
        const parent = columnByStep(parentStep);
        const parentItems = parent ? menuitemsIn(parent) : [];
        const match = label
          ? parentItems.find((item) => item.textContent?.trim() === label)
          : undefined;
        focusItem(match) || focusExpandedOrFirst(parent);
        skipExpandOnFocusRef.current = false;
      });
    };

    const enterDeeper = (): void => {
      const item = items[index];
      if (!item || item.getAttribute("aria-haspopup") !== "menu") return;
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      const step = stepOf(column);
      const nextStep: CascadeStep | null =
        step === "profile" ? "model" : step === "model" ? "effort" : null;
      if (!nextStep) return;
      const label = item.textContent?.trim() ?? "";
      if (step === "profile") {
        const profile = profileChoices.find((choice) => choice.name === label);
        if (profile) {
          setActiveProfile(profile);
          setActiveModel(null);
        }
      } else if (step === "model") {
        const model = modelChoices.find((choice) => choice.label === label);
        if (model) setActiveModel(model);
      }
      pendingEnterStepRef.current = nextStep;
      if (focusFirstInColumn(columnByStep(nextStep))) {
        pendingEnterStepRef.current = null;
      }
    };

    const retreat = (): void => {
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      const step = stepOf(column);
      if (step === "effort") {
        const label = activeModel?.label;
        setActiveModel(null);
        focusParentColumn("model", label);
        return;
      }
      if (step === "model" && harness === "hermes") {
        const label = activeProfile?.name;
        setActiveModel(null);
        focusParentColumn("profile", label);
        return;
      }
      exitCascade();
    };

    switch (event.key) {
      case "ArrowDown":
        focusAt(Math.min(index + 1, items.length - 1));
        return;
      case "ArrowUp":
        focusAt(Math.max(index - 1, 0));
        return;
      case "Home":
        focusAt(0);
        return;
      case "End":
        focusAt(items.length - 1);
        return;
      case "ArrowRight":
      case "ArrowLeft": {
        if (event.key === enterKey) {
          enterDeeper();
          return;
        }
        if (event.key === retreatKey) {
          retreat();
          return;
        }
        return;
      }
      case "Escape": {
        retreat();
        return;
      }
      case "Enter":
      case " ": {
        // Native button activation commits the focused leaf, or the defaults
        // on an expandable row (same as click). Stop bubbling so the deck
        // does not treat this as a search-bridge Enter.
        event.stopPropagation();
        resetTypeahead();
        return;
      }
      default: {
        if (!isPrintableKey(event) || event.key === " ") return;
        event.preventDefault();
        event.stopPropagation();
        typeaheadRef.current = typeaheadAccept(
          typeaheadRef.current,
          event.key,
          Date.now(),
        );
        typeaheadStepRef.current = columnStep;
        const labels = items.map((item) => item.textContent?.trim() ?? "");
        const next = typeaheadIndex(
          labels,
          typeaheadRef.current.text,
          index,
        );
        if (next === null) return;
        focusItem(items[next]);
      }
    }
  };

  const defaultsItem = (
    <CascadeItem
      label={DEFAULTS_LABEL}
      skipExpandRef={skipExpandOnFocusRef}
      onEnter={() => {
        setActiveProfile(null);
        setActiveModel(null);
      }}
      onSelect={() => configure({ harness })}
    />
  );

  return createPortal(
    <div
      ref={rootRef}
      className="agent-cascade"
      data-canvas-menu-surface
      style={{ position: "fixed", zIndex: 70, ...position } as CSSProperties}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      // Keyboard handoff: focus entering a menuitem must cancel the palette's
      // blur→close timer the same way pointerenter does.
      onFocusCapture={(event) => {
        onPointerEnter();
        const column = event.target instanceof Element
          ? event.target.closest(".agent-cascade__items")
          : null;
        const step = column instanceof Element ? stepOf(column) : null;
        if (step !== typeaheadStepRef.current) {
          typeaheadRef.current = { text: "", at: 0 };
          typeaheadStepRef.current = step;
        }
      }}
      onKeyDown={onCascadeKeyDown}
    >
      <MenuColumn
        label={
          harness === "hermes"
            ? "Hermes profiles"
            : usesModes
              ? `${templateFor(harness).displayName} modes`
              : `${templateFor(harness).displayName} models`
        }
        parent={templateFor(harness).displayName}
        step={harness === "hermes" ? "profile" : "model"}
      >
        {firstColumnIsLoading ? (
          <LoadingRows />
        ) : usesModes ? (
          <>
            {templateModes.map((mode) => (
              <CascadeItem
                key={mode}
                label={mode}
                skipExpandRef={skipExpandOnFocusRef}
                onSelect={() => configure({ harness, mode })}
              />
            ))}
            {defaultsItem}
          </>
        ) : harness === "hermes" ? (
          <>
            {profileChoices.map((profile) => {
              // Chevron only when a model column can open (loading or non-empty).
              const canExpandModels =
                models === null || modelChoices.length > 0;
              return (
                <CascadeItem
                  key={profile.name}
                  label={profile.name}
                  skipExpandRef={skipExpandOnFocusRef}
                  expanded={
                    canExpandModels ? activeProfile?.name === profile.name : undefined
                  }
                  onEnter={() => {
                    setActiveProfile(profile);
                    setActiveModel(null);
                  }}
                  onSelect={() =>
                    configure({
                      harness,
                      profile: profile.name,
                      ...(profile.model ? { model: profile.model } : {}),
                    })
                  }
                />
              );
            })}
            {defaultsItem}
          </>
        ) : (
          <>
            {modelChoices.map((model) => {
              const hasEfforts =
                (model.efforts?.length ?? 0) > 0 ||
                enumeratedEfforts.length > 0 ||
                templateFor(harness).efforts.length > 0;
              return (
                <CascadeItem
                  key={model.id}
                  label={model.label}
                  skipExpandRef={skipExpandOnFocusRef}
                  expanded={hasEfforts ? activeModel?.id === model.id : undefined}
                  onEnter={() => setActiveModel(model)}
                  onSelect={() => configure({ harness, model: model.id })}
                />
              );
            })}
            {defaultsItem}
          </>
        )}
      </MenuColumn>

      {showModelColumn ? (
        <MenuColumn
          label={`${activeProfile?.name ?? "Hermes"} models`}
          parent={activeProfile?.name ?? "Hermes"}
          step="model"
        >
          {models === null ? (
            <LoadingRows />
          ) : (
            modelChoices.map((model) => {
              const hasEfforts =
                (model.efforts?.length ?? 0) > 0 ||
                enumeratedEfforts.length > 0 ||
                templateFor(harness).efforts.length > 0;
              return (
                <CascadeItem
                  key={model.id}
                  label={model.label}
                  skipExpandRef={skipExpandOnFocusRef}
                  expanded={hasEfforts ? activeModel?.id === model.id : undefined}
                  onEnter={() => setActiveModel(model)}
                  onSelect={() =>
                    configure({
                      harness,
                      ...(activeProfile ? { profile: activeProfile.name } : {}),
                      model: model.id,
                    })
                  }
                />
              );
            })
          )}
        </MenuColumn>
      ) : null}

      {showEffortColumn ? (
        <MenuColumn
          label={`${activeModel.label} effort`}
          parent={activeModel.label}
          step="effort"
        >
          {efforts.map((effort) => (
            <CascadeItem
              key={effort}
              label={effort}
              skipExpandRef={skipExpandOnFocusRef}
              onSelect={() =>
                configure({
                  harness,
                  ...(activeProfile ? { profile: activeProfile.name } : {}),
                  model: activeModel.id,
                  effort,
                })
              }
            />
          ))}
        </MenuColumn>
      ) : null}
    </div>,
    document.body,
  );
}
