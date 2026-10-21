import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { ArrowLeft, ArrowRight, Hand, MessageSquarePlus, Plus, RotateCw, Undo2, X } from "lucide-react";
import type { BrowserBoxApi, BrowserBoxDraft, BrowserChromeState } from "@shared/browser-chrome";
import type { BrowserTabId } from "@shared/browser-tab";
import { activeTab } from "@shared/page-tabs";
import type { ChromeCommand } from "../../lib/browser-chrome-source";
import { addressTarget, boxShotSpent, driverView, refusalLine, tabLabel, takeoverOffer } from "../../lib/browser-chrome-model";
import type { BrowserChromeOutcome } from "@shared/browser-chrome";
import { claimFocus } from "../../lib/focus-ownership";
import { registerPageChromeKeys } from "../../lib/page-chrome-keys";
import { Button, IconButton, Input, StatusDot } from "../ui";
import { BoxCommentComposer } from "./BoxCommentComposer";
import "./browser-chrome.css";

/** Who is driving the page, as a mark and one sentence. A running seat's lamp pulses. */
export function DriverMark({
  state,
  now,
  seatName,
}: {
  readonly state: BrowserChromeState;
  readonly now: number;
  readonly seatName: (nodeId: string) => string | undefined;
}) {
  const view = driverView(state.driving, now, seatName);
  const tone = view.kind === "operator-held" ? "amber" : view.kind === "seat" ? "cyan" : view.kind === "operator" ? "green" : "steel";
  return (
    <span className="driver-mark" data-kind={view.kind} data-live={view.live ? "true" : undefined} role="status">
      <StatusDot tone={tone} pulse={view.live} />
      <span>{view.text}</span>
    </span>
  );
}

/** One control: take the page over, or hand it back while you hold it. */
export function TakeoverControl({
  state,
  pending,
  onCommand,
}: {
  readonly state: BrowserChromeState;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
}) {
  const offer = takeoverOffer(state.driving);
  const release = offer.action === "release";
  return (
    <Button
      size="xs"
      variant={release ? "primary" : "chrome"}
      disabled={pending}
      data-testid={release ? "browser-release" : "browser-takeover"}
      title={release ? "Let the connected seats act on this page again" : "Pause every seat on this page and drive it yourself"}
      onClick={() => onCommand({ kind: release ? "release" : "takeOver" })}
    >
      {release ? <Undo2 size={12} aria-hidden /> : <Hand size={12} aria-hidden />}
      {offer.label}
    </Button>
  );
}

/**
 * The tabs in order; the active one is marked. The tablist owns only tabs
 * (each wrapped in a presentational row with its close button, which the mouse
 * uses; the keyboard closes a focused tab with Delete). One tab is in the tab
 * order at a time; Left and Right move to the neighbour and activate it. The
 * new-tab button sits beside the list, not inside it.
 */
export function TabStrip({
  state,
  pending,
  onCommand,
  controls,
}: {
  readonly state: BrowserChromeState;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
  /** The id of the surface region the tabs control. */
  readonly controls?: string;
}) {
  const { tabs, active } = state.tabs;
  const only = tabs.length === 1;
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<number | null>(null);
  useEffect(() => {
    const at = focusAfter.current;
    if (at === null) return;
    focusAfter.current = null;
    claimFocus(listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[at], "gesture");
  }, [tabs.length]);
  // Manual activation (APG): arrows, Home and End move focus only, since
  // activating a tab swaps a live view; Enter and Space activate (the button's
  // own click). Delete closes the focused tab, never the last, and focus lands
  // on the tab that takes its place.
  const move = (event: KeyboardEvent<HTMLButtonElement>, tab: BrowserTabId): void => {
    const index = tabs.findIndex((candidate) => candidate.id === tab);
    const buttons = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]');
    const focusAt = (at: number): void => {
      event.preventDefault();
      claimFocus(buttons?.[at], "gesture", { event });
    };
    switch (event.key) {
      case "ArrowRight":
        return focusAt((index + 1) % tabs.length);
      case "ArrowLeft":
        return focusAt((index - 1 + tabs.length) % tabs.length);
      case "Home":
        return focusAt(0);
      case "End":
        return focusAt(tabs.length - 1);
      case "Delete": {
        if (only) return;
        event.preventDefault();
        // Focus the tab that will sit here once the strip re-renders without this one.
        focusAfter.current = Math.min(index, tabs.length - 2);
        onCommand({ kind: "closeTab", tab });
        return;
      }
    }
  };
  return (
    <div className="tab-strip" data-testid="browser-tabs">
      <div className="tab-strip__list" role="tablist" aria-label="Tabs" ref={listRef}>
        {tabs.map((tab) => {
          const label = tabLabel(tab);
          return (
            <div key={tab.id} role="presentation" className="tab-strip__tab" data-active={tab.id === active ? "true" : undefined} data-loading={tab.loading ? "true" : undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={tab.id === active}
                tabIndex={tab.id === active ? 0 : -1}
                className="tab-strip__label"
                title={tab.url === "" ? label : `${label}\n${tab.url}`}
                disabled={pending}
                onClick={() => onCommand({ kind: "activateTab", tab: tab.id as BrowserTabId })}
                onKeyDown={(event) => move(event, tab.id as BrowserTabId)}
                aria-controls={controls}
              >
                {tab.loading ? <span className="tab-strip__loading" aria-hidden /> : null}
                <span className="truncate">{label}</span>
                {tab.loading ? <span className="sr-only">, loading</span> : null}
              </button>
              {only ? null : (
                <IconButton
                  aria-label={`Close ${label}`}
                  title="Close tab (Delete on the tab)"
                  size="xs"
                  tabIndex={-1}
                  disabled={pending}
                  onClick={() => onCommand({ kind: "closeTab", tab: tab.id as BrowserTabId })}
                >
                  <X size={11} />
                </IconButton>
              )}
            </div>
          );
        })}
      </div>
      <IconButton
        aria-label="New tab"
        title="New tab"
        size="sm"
        disabled={pending}
        onClick={() => onCommand({ kind: "openTab" })}
      >
        <Plus size={13} />
      </IconButton>
    </div>
  );
}

/** Back, forward, reload and the address of the active tab. A typed address is judged by the same policy main applies. */
export function AddressBar({
  state,
  pending,
  onCommand,
  onRefused,
  onFocusPage,
  inputRef,
}: {
  readonly state: BrowserChromeState;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
  readonly onRefused: (message: string) => void;
  /** Move keyboard focus into the page: after Enter goes, and on Escape. */
  readonly onFocusPage: () => void;
  /** The address field, so the page's key (Cmd+L) can focus it. */
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  const tab = activeTab(state.tabs);
  const [typed, setTyped] = useState(tab.url);
  useEffect(() => setTyped(tab.url), [tab.id, tab.url]);
  return (
    <form
      className="address-bar"
      aria-label="Address"
      onSubmit={(event) => {
        event.preventDefault();
        const target = addressTarget(typed);
        if (target.ok) {
          onCommand({ kind: "goto", url: target.url });
          onFocusPage();
        } else onRefused(target.message);
      }}
    >
      <IconButton aria-label="Back" title="Back" size="sm" disabled={pending || !tab.canGoBack} onClick={() => onCommand({ kind: "traverse", step: "back" })}>
        <ArrowLeft size={14} />
      </IconButton>
      <IconButton aria-label="Forward" title="Forward" size="sm" disabled={pending || !tab.canGoForward} onClick={() => onCommand({ kind: "traverse", step: "forward" })}>
        <ArrowRight size={14} />
      </IconButton>
      {/* One slot for Reload and Stop: the same element, so focus stays put while the tab loads. */}
      <IconButton
        aria-label={tab.loading ? "Stop" : "Reload"}
        title={tab.loading ? "Stop loading" : "Reload"}
        size="sm"
        disabled={pending}
        data-testid="browser-reload-stop"
        onClick={() => onCommand({ kind: "traverse", step: tab.loading ? "stop" : "reload" })}
      >
        {tab.loading ? <X size={14} /> : <RotateCw size={14} />}
      </IconButton>
      <Input
        dense
        ref={inputRef}
        aria-label="Address"
        placeholder="Search or type an address"
        spellCheck={false}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        onKeyDown={(event) => {
          // First Escape: the address goes back to the page's own and focus returns to the page.
          // The surface's own Escape is the second one.
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          setTyped(tab.url);
          onFocusPage();
        }}
      />
    </form>
  );
}

/**
 * The page's chrome (plan 06): tab strip, address bar, who is driving and the
 * operator's takeover. `onCommand` runs one command and answers its outcome;
 * a refusal is said here in one line and nothing is lost. `trailing` is where
 * the surface puts its own buttons (stop, close).
 */
/**
 * The operator took over a tab whose document a seat ran code in: code it
 * left may still watch what they type, until a reload (main's line, as is).
 */
export function SeatCodeNotice({
  state,
  pending,
  onCommand,
}: {
  readonly state: BrowserChromeState;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
}) {
  const notice = state.seatCode;
  if (notice === undefined || !notice.tabs.includes(state.tabs.active)) return null;
  return (
    <div className="browser-chrome__notice" role="status" data-testid="browser-chrome-seat-code">
      <span>{notice.message}</span>
      <Button size="xs" variant="chrome" disabled={pending} onClick={() => onCommand({ kind: "traverse", step: "reload" })}>
        <RotateCw size={12} aria-hidden />
        Reload
      </Button>
    </div>
  );
}

export function BrowserChrome({
  state,
  now,
  seatName,
  onCommand,
  onFocusPage,
  controls,
  box,
  sessionId,
  canvasName,
  nodeId,
  trailing,
}: {
  readonly state: BrowserChromeState;
  readonly now: number;
  readonly seatName: (nodeId: string) => string | undefined;
  readonly onCommand: (command: ChromeCommand) => Promise<BrowserChromeOutcome>;
  /** Move keyboard focus into the page view (the surface owns where it goes when it cannot). */
  readonly onFocusPage: () => void;
  /** The id of the surface region the tabs control. */
  readonly controls?: string;
  /** Comment on an area, when main serves it; with the page's session id. */
  readonly box?: BrowserBoxApi;
  readonly sessionId?: string;
  /** The canvas and the page node, for the seats a comment may mention. */
  readonly canvasName?: string;
  readonly nodeId?: string;
  readonly trailing?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const run = (command: ChromeCommand): void => {
    setPending(true);
    setRefused(null);
    void onCommand(command)
      .then((outcome) => {
        if (!outcome.ok) setRefused(refusalLine(outcome.refusal));
      })
      .finally(() => setPending(false));
  };
  // A comment on an area: drawing in the page, then the staged shot shown before it posts.
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState<BrowserBoxDraft | null>(null);
  const [posting, setPosting] = useState(false);
  const canBox = box !== undefined && sessionId !== undefined;
  const startBox = (): void => {
    if (box === undefined || sessionId === undefined || drawing) return;
    setDrawing(true);
    setRefused(null);
    void box
      .start(sessionId)
      .then((result) => {
        if (result.kind === "drawn") setDraft(result.draft);
        else if (result.kind === "refused") setRefused(refusalLine(result.refusal));
      })
      .finally(() => setDrawing(false));
  };
  const discardBox = (): void => {
    if (box !== undefined && sessionId !== undefined && draft !== null) void box.discard(sessionId, draft.shotId);
    setDraft(null);
  };
  const postBox = (text: string): void => {
    if (box === undefined || sessionId === undefined || draft === null) return;
    setPosting(true);
    void box
      .post(sessionId, draft.shotId, text)
      .then((outcome) => {
        if (outcome.ok) setDraft(null);
        else {
          setRefused(refusalLine(outcome.refusal));
          // A spent shot cannot be posted again: the composer closes and the operator draws a new box.
          if (boxShotSpent(outcome.refusal)) setDraft(null);
        }
      })
      .finally(() => setPosting(false));
  };
  // While this chrome shows it is the page in front for Cmd+L and Cmd+R (the
  // menu hands them back as keydowns, so they work while the page has focus).
  const addressRef = useRef<HTMLInputElement>(null);
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(
    () =>
      registerPageChromeKeys({
        address: () => {
          claimFocus(addressRef.current, "gesture", { select: true });
        },
        reload: () => runRef.current({ kind: "traverse", step: "reload" }),
      }),
    [],
  );
  return (
    <div className="browser-chrome" data-testid="browser-chrome">
      <TabStrip state={state} pending={pending} onCommand={run} controls={controls} />
      <div className="browser-chrome__row">
        <AddressBar state={state} pending={pending} onCommand={run} onRefused={setRefused} onFocusPage={onFocusPage} inputRef={addressRef} />
        <DriverMark state={state} now={now} seatName={seatName} />
        {canBox ? (
          <Button
            size="xs"
            variant="chrome"
            disabled={pending || drawing || draft !== null}
            data-testid="browser-comment-area"
            title="Draw a box on the page to comment on it"
            onClick={startBox}
          >
            <MessageSquarePlus size={12} aria-hidden />
            {drawing ? "Draw on the page" : "Comment on an area"}
          </Button>
        ) : null}
        <TakeoverControl state={state} pending={pending} onCommand={run} />
        {trailing}
      </div>
      <SeatCodeNotice state={state} pending={pending} onCommand={run} />
      {draft === null ? null : (
        <BoxCommentComposer draft={draft} canvasName={canvasName ?? ""} nodeId={nodeId ?? ""} pending={posting} onPost={postBox} onDiscard={discardBox} />
      )}
      {refused === null ? null : (
        <p className="browser-chrome__refused" role="alert" data-testid="browser-chrome-refused">
          {refused}
        </p>
      )}
    </div>
  );
}
