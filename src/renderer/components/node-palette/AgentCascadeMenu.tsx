import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Search } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import {
  templateFor,
  type HarnessId,
} from "@shared/managed-terminal-templates";
import type {
  ManagedTerminalModelOption,
  ManagedTerminalModelsResult,
  ManagedTerminalProfileOption,
} from "@shared/ipc";
import { harnessPrefsFor } from "@shared/settings";
import { state$ } from "../../lib/state";
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
import { arrangeModels, MODEL_SEARCH_MIN, orderModels } from "./model-choices";

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
const DEFAULT_EFFORT_LABEL = "Default effort";
const PROFILE_DEFAULTS_LABEL = "Use profile defaults";

/** The defaults row says which click it stands for. */
const sameAsClicking = (name: string): string => `same as clicking ${name}`;

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

/** The first real choice: past the defaults row when a search is narrowing. */
const focusFirstResult = (column: Element | null | undefined): boolean => {
  const items = column ? menuitemsIn(column) : [];
  return focusItem(items.find((item) => !item.classList.contains("is-default")) ?? items[0]);
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
  search,
  children,
}: {
  readonly label: string;
  readonly step: CascadeStep;
  readonly parent: string;
  readonly search?: ReactNode;
  readonly children: ReactNode;
}) {
  // The whole column is the menu, its search field included, so moving
  // between the field and the rows stays inside one focus scope.
  return (
    <div className="agent-cascade__column" data-cascade-step={step} role="menu" aria-label={label}>
      <div className="agent-cascade__head">
        <div className="agent-cascade__caption" aria-hidden>
          <span className="agent-cascade__caption-parent">{parent}</span>
          <span className="agent-cascade__caption-step">{step}</span>
        </div>
        {search}
      </div>
      <div className="agent-cascade__items" data-cascade-step={step}>
        {children}
      </div>
    </div>
  );
}

/**
 * The column's filter. Arrow Down steps into the results, Enter takes the top
 * one, Escape clears the text and then leaves the column.
 */
function ModelSearch({
  inputRef,
  label,
  value,
  onChange,
  onKeyDown,
}: {
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="agent-cascade__search">
      <Search size={11} aria-hidden />
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="Search models"
        aria-label={label}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    </label>
  );
}

function CascadeItem({
  label,
  hint,
  isDefault = false,
  expanded,
  onEnter,
  onSelect,
  skipExpandRef,
}: {
  readonly label: string;
  /** A second line under the label; not part of the accessible name. */
  readonly hint?: string;
  /** The row a plain click on the parent stands for: lit until another row is. */
  readonly isDefault?: boolean;
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
      className={isDefault ? "is-default" : undefined}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      aria-expanded={expanded}
      onMouseEnter={onEnter}
      onFocus={() => {
        if (skipExpandRef.current) return;
        onEnter?.();
      }}
      onClick={onSelect}
    >
      {hint ? (
        <span className="agent-cascade__stack">
          <span>{label}</span>
          <small aria-hidden>{hint}</small>
        </span>
      ) : (
        <span>{label}</span>
      )}
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
  const [modelSource, setModelSource] = useState<ManagedTerminalModelsResult["source"]>();
  const [modelQuery, setModelQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const settings = use$(state$.settings);
  const recentModels = harnessPrefsFor(settings, harness).recentModels;
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
        setModelSource(result.source);
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
    const base = orderModels(models ?? [], modelSource);
    if (harness !== "hermes" || !activeProfile?.model) return base;
    const pin = activeProfile.model;
    const rest = base.filter((m) => m.id !== pin);
    const pinned = base.find((m) => m.id === pin) ?? { id: pin, label: pin };
    return [pinned, ...rest];
  }, [models, modelSource, harness, activeProfile]);
  const arranged = useMemo(
    () => arrangeModels(modelChoices, recentModels, modelQuery),
    [modelChoices, recentModels, modelQuery],
  );
  const searching = modelQuery.trim().length > 0;
  const showSearch = modelChoices.length >= MODEL_SEARCH_MIN;
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

  /** A new search drops the model the effort column was opened for. */
  const changeQuery = (next: string): void => {
    setModelQuery(next);
    setActiveModel(null);
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    // Tab leaves the cascade through the root handler, like any row.
    if (event.key === "Tab") return;
    event.stopPropagation();
    const column = columnByStep("model");
    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        if (searching) focusFirstResult(column);
        else focusFirstInColumn(column);
        return;
      }
      case "Enter": {
        event.preventDefault();
        const top = arranged.rest[0];
        if (!searching || !top) return;
        configure({
          harness,
          ...(harness === "hermes" && activeProfile ? { profile: activeProfile.name } : {}),
          model: top.id,
        });
        return;
      }
      case "Escape": {
        event.preventDefault();
        if (modelQuery) {
          changeQuery("");
          return;
        }
        if (harness === "hermes" && activeProfile) {
          const label = activeProfile.name;
          setActiveModel(null);
          skipExpandOnFocusRef.current = true;
          requestAnimationFrame(() => {
            const parent = columnByStep("profile");
            const match = parent
              ? menuitemsIn(parent).find((item) => item.textContent?.trim() === label)
              : undefined;
            focusItem(match) || focusExpandedOrFirst(parent);
            skipExpandOnFocusRef.current = false;
          });
          return;
        }
        exitCascade();
        return;
      }
      default:
        return;
    }
  };

  // Hermes: each profile's model column starts unfiltered.
  useEffect(() => {
    setModelQuery("");
  }, [activeProfile?.name]);

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
        // A searchable model column sends typing to its search field.
        if (columnStep === "model" && showSearch && searchRef.current) {
          const edit = event.key === "Backspace" ? "back" : isPrintableKey(event) && event.key !== " " ? "type" : null;
          if (!edit) return;
          event.preventDefault();
          event.stopPropagation();
          resetTypeahead();
          changeQuery(edit === "back" ? modelQuery.slice(0, -1) : modelQuery + event.key);
          claimFocus(searchRef.current, "gesture");
          return;
        }
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

  const displayName = templateFor(harness).displayName;
  const hasEffortsFor = (model: ManagedTerminalModelOption): boolean =>
    (model.efforts?.length ?? 0) > 0 ||
    enumeratedEfforts.length > 0 ||
    templateFor(harness).efforts.length > 0;
  const profileChoice = (): { readonly profile?: string } =>
    harness === "hermes" && activeProfile ? { profile: activeProfile.name } : {};

  // First in every column, and lit until the pointer or keys pick another
  // row: a plain click on the agent (or the model) means exactly this.
  const defaultsItem = (
    <CascadeItem
      label={DEFAULTS_LABEL}
      hint={sameAsClicking(displayName)}
      isDefault
      skipExpandRef={skipExpandOnFocusRef}
      onEnter={() => {
        setActiveProfile(null);
        setActiveModel(null);
      }}
      onSelect={() => configure({ harness })}
    />
  );

  const modelItem = (model: ManagedTerminalModelOption) => (
    <CascadeItem
      key={model.id}
      label={model.label}
      skipExpandRef={skipExpandOnFocusRef}
      expanded={hasEffortsFor(model) ? activeModel?.id === model.id : undefined}
      onEnter={() => setActiveModel(model)}
      onSelect={() => configure({ harness, ...profileChoice(), model: model.id })}
    />
  );

  /** Recent picks on this harness, then the rest; one ranked list while searching. */
  const modelList = (lead: ReactNode) => (
    <>
      {searching ? null : lead}
      {arranged.recent.length > 0 ? (
        <div role="group" aria-label={`Recent ${displayName} models`}>
          <div className="agent-cascade__group" aria-hidden>
            recent
          </div>
          {arranged.recent.map(modelItem)}
        </div>
      ) : null}
      {arranged.recent.length > 0 && arranged.rest.length > 0 ? (
        <div className="agent-cascade__group" aria-hidden>
          all models
        </div>
      ) : null}
      {arranged.rest.map(modelItem)}
      {searching && arranged.rest.length === 0 ? (
        <p className="agent-cascade__empty" role="status">
          No models match &ldquo;{modelQuery.trim()}&rdquo;
        </p>
      ) : null}
    </>
  );

  const search = (label: string) =>
    showSearch ? (
      <ModelSearch
        inputRef={searchRef}
        label={label}
        value={modelQuery}
        onChange={changeQuery}
        onKeyDown={onSearchKeyDown}
      />
    ) : undefined;

  return createPortal(
    <div
      ref={rootRef}
      className="agent-cascade"
      data-popover-layer
      data-canvas-menu-surface
      // The top layer: above the dialog or popover it was opened from (Add
      // item, the agent editor's Launch tab, the re-seat pop).
      style={{ position: "fixed", zIndex: "var(--layer-flyout)", ...position } as CSSProperties}
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
              ? `${displayName} modes`
              : `${displayName} models`
        }
        parent={displayName}
        step={harness === "hermes" ? "profile" : "model"}
        {...(harness !== "hermes" && !usesModes && !firstColumnIsLoading
          ? { search: search(`Search ${displayName} models`) }
          : {})}
      >
        {firstColumnIsLoading ? (
          <LoadingRows />
        ) : usesModes ? (
          <>
            {defaultsItem}
            {templateModes.map((mode) => (
              <CascadeItem
                key={mode}
                label={mode}
                skipExpandRef={skipExpandOnFocusRef}
                onSelect={() => configure({ harness, mode })}
              />
            ))}
          </>
        ) : harness === "hermes" ? (
          <>
            {defaultsItem}
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
          </>
        ) : (
          modelList(defaultsItem)
        )}
      </MenuColumn>

      {showModelColumn ? (
        <MenuColumn
          label={`${activeProfile?.name ?? "Hermes"} models`}
          parent={activeProfile?.name ?? "Hermes"}
          step="model"
          {...(models === null ? {} : { search: search(`Search ${activeProfile?.name ?? "Hermes"} models`) })}
        >
          {models === null ? (
            <LoadingRows />
          ) : (
            modelList(
              activeProfile ? (
                <CascadeItem
                  label={PROFILE_DEFAULTS_LABEL}
                  hint={sameAsClicking(activeProfile.name)}
                  isDefault
                  skipExpandRef={skipExpandOnFocusRef}
                  onEnter={() => setActiveModel(null)}
                  onSelect={() =>
                    configure({
                      harness,
                      profile: activeProfile.name,
                      ...(activeProfile.model ? { model: activeProfile.model } : {}),
                    })
                  }
                />
              ) : null,
            )
          )}
        </MenuColumn>
      ) : null}

      {showEffortColumn ? (
        <MenuColumn
          label={`${activeModel.label} effort`}
          parent={activeModel.label}
          step="effort"
        >
          <CascadeItem
            label={DEFAULT_EFFORT_LABEL}
            hint={sameAsClicking(activeModel.label)}
            isDefault
            skipExpandRef={skipExpandOnFocusRef}
            onSelect={() => configure({ harness, ...profileChoice(), model: activeModel.id })}
          />
          {efforts.map((effort) => (
            <CascadeItem
              key={effort}
              label={effort}
              skipExpandRef={skipExpandOnFocusRef}
              onSelect={() =>
                configure({
                  harness,
                  ...profileChoice(),
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
