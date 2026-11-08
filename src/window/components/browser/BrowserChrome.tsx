import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { ArrowLeft, ArrowRight, Hand, MessageSquarePlus, Plus, RotateCw, Undo2, X } from "lucide-react";
import type { BrowserBoxApi, BrowserBoxDraft, BrowserChromeState } from "@shared/browser-chrome";
import type { BrowserTabId } from "@shared/browser-tab";
import { activeTab } from "@shared/page-tabs";
import type { ChromeCommand } from "../../lib/browser-chrome-source";
import { addressParts, addressTarget, boxShotSpent, driverView, refusalLine, tabLabel, takeoverOffer } from "../../lib/browser-chrome-model";
import type { BrowserChromeOutcome } from "@shared/browser-chrome";
import { claimFocus } from "../../lib/focus-ownership";
import { registerPageChromeKeys } from "../../lib/page-chrome-keys";
import { Button, IconButton, Input, StatusDot } from "../ui";
import { BoxCommentComposer } from "./BoxCommentComposer";
import "./browser-chrome.css";

/**
 * Who is driving the page, as a mark and words. A running seat's lamp pulses;
 * a seat that drove last goes quiet. Nobody driving says nothing aloud but
 * still says it to a screen reader.
 */
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
  if (view.kind === "idle") {
    return (
      <span className="sr-only" role="status">
        {view.text}
      </span>
    );
  }
  const tone = view.kind === "operator-held" ? "amber" : view.kind === "operator" ? "green" : view.live ? "cyan" : "steel";
  return (
    <span className="driver-mark" data-kind={view.kind} data-live={view.live ? "true" : undefined} role="status" title={view.text}>
      <StatusDot tone={tone} pulse={view.live} />
      {view.seat === undefined ? (
        <span className="driver-mark__text">{view.kind === "operator-held" ? "You hold this page" : view.text}</span>
      ) : (
        <span className="driver-mark__text">
          <span className="driver-mark__seat">{view.seat}</span>
          <span className="driver-mark__verb">{view.live ? " is driving" : " drove last"}</span>
        </span>
      )}
    </span>
  );
}

/** One control: take the page over, or hand it back while you hold it. */
export function TakeoverControl({
  state,
  now,
  seatName,
  pending,
  onCommand,
}: {
  readonly state: BrowserChromeState;
  readonly now: number;
  readonly seatName: (nodeId: string) => string | undefined;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
}) {
  const offer = takeoverOffer(state.driving);
  const release = offer.action === "release";
  const seat = driverView(state.driving, now, seatName).seat;
  return (
    <Button
      size="xs"
      variant={release ? "primary" : "chrome"}
      className="chrome-action"
      disabled={pending}
      data-testid={release ? "browser-release" : "browser-takeover"}
      aria-label={release || seat === undefined ? undefined : `${offer.label} from ${seat}`}
      title={release ? "Let the connected seats act on this page again" : "Pause every seat on this page and drive it yourself"}
      onClick={() => onCommand({ kind: release ? "release" : "takeOver" })}
    >
      {release ? <Undo2 size={12} aria-hidden /> : <Hand size={12} aria-hidden />}
      {offer.label}
    </Button>
  );
}

/** Who drives and the one control over it, as one piece. */
export function DriverControl(props: {
  readonly state: BrowserChromeState;
  readonly now: number;
  readonly seatName: (nodeId: string) => string | undefined;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
}) {
  const view = driverView(props.state.driving, props.now, props.seatName);
  return (
    <div className="driver-control" data-kind={view.kind} data-live={view.live ? "true" : undefined}>
      <DriverMark state={props.state} now={props.now} seatName={props.seatName} />
      <TakeoverControl {...props} />
    </div>
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
  // The shown tab stays in sight when the strip scrolls.
  useEffect(() => {
    listRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);
  // Whether the tabs overflow the strip, so its far edge fades.
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const measure = (): void => setOverflow(list.scrollWidth > list.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tabs.length]);
  // A tab scrolled out of the strip is marked unseen, so its loading spinner
  // stops (operator signal 01M63W6RQY1YT2Q65MCM0N3YQ8). Set on the DOM, never
  // a render; a tab is seen until the observer says otherwise.
  const tabIds = tabs.map((tab) => tab.id).join(" ");
  useEffect(() => {
    const list = listRef.current;
    if (list === null || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) entry.target.toggleAttribute("data-unseen", !entry.isIntersecting);
      },
      { root: list },
    );
    for (const tab of list.querySelectorAll(".tab-strip__tab")) observer.observe(tab);
    return () => observer.disconnect();
  }, [tabIds]);
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
      <div className="tab-strip__list" role="tablist" aria-label="Tabs" ref={listRef} data-overflow={overflow ? "true" : undefined}>
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
                  className="tab-strip__close"
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
  const [editing, setEditing] = useState(false);
  const shown = editing || typed !== tab.url ? undefined : addressParts(tab.url);
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
      {/* At rest the page's own address shows its host in ink, scheme and path quiet; editing shows it plain. */}
      <span className="address-bar__field" data-shown={shown === undefined ? undefined : "true"}>
        <Input
          dense
          ref={inputRef}
          aria-label="Address"
          placeholder="Search or type an address"
          spellCheck={false}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
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
        {shown === undefined ? null : (
          <span className="address-bar__shown" aria-hidden>
            <span className="address-bar__quiet">{shown.before}</span>
            {shown.host}
            <span className="address-bar__quiet">{shown.after}</span>
          </span>
        )}
      </span>
    </form>
  );
}

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
      <Button size="xs" variant="chrome" className="chrome-action" disabled={pending} onClick={() => onCommand({ kind: "traverse", step: "reload" })}>
        <RotateCw size={12} aria-hidden />
        Reload
      </Button>
    </div>
  );
}

/**
 * The page's last refused navigation, in main's words, while it stands: until
 * the tab shows another document. A line, not an alert: nothing the operator
 * did failed, a page asked to go somewhere that is not allowed.
 */
export function NavigationBlockNotice({ state }: { readonly state: BrowserChromeState }) {
  const blocked = state.blocked;
  if (blocked === undefined || blocked.tab !== state.tabs.active) return null;
  return (
    <p className="browser-chrome__refused" role="status" data-testid="browser-chrome-blocked">
      {blocked.message}
    </p>
  );
}

/**
 * The chrome before the page's own state is served, or after its session
 * ended: the same two bands, one tab named for the page, its address read
 * only and one line of status, so opening a page never flashes another face.
 */
export function PendingChrome({
  title,
  url,
  status,
  alert = false,
  trailing,
}: {
  readonly title: string;
  readonly url: string;
  readonly status: string;
  /** The status is a failure, not a wait. */
  readonly alert?: boolean;
  readonly trailing?: ReactNode;
}) {
  const parts = addressParts(url);
  return (
    <div className="browser-chrome" data-testid="browser-chrome-pending" data-driver="idle">
      <div className="browser-chrome__top">
        <div className="tab-strip">
          <div className="tab-strip__list">
            <div className="tab-strip__tab" data-active="true">
              <span className="tab-strip__label" title={url === "" ? title : `${title}\n${url}`}>
                <span className="truncate">{title}</span>
              </span>
            </div>
          </div>
        </div>
        {trailing === undefined ? null : <div className="browser-chrome__window">{trailing}</div>}
      </div>
      <div className="browser-chrome__row">
        <span className="browser-chrome__address" title={url}>
          {parts === undefined ? (
            url
          ) : (
            <>
              <span className="address-bar__quiet">{parts.before}</span>
              {parts.host}
              <span className="address-bar__quiet">{parts.after}</span>
            </>
          )}
        </span>
        <span className="browser-chrome__status" data-alert={alert ? "true" : undefined} role={alert ? "alert" : "status"}>
          {status}
        </span>
      </div>
    </div>
  );
}

/**
 * The page's chrome (plan 06): tab strip, address bar, who is driving and the
 * operator's takeover. `onCommand` runs one command and answers its outcome;
 * a refusal is said here in one line and nothing is lost. `trailing` is where
 * the surface puts its own buttons (stop, close).
 */
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
  // Who drives colours the chrome's lower edge, the line where the page begins.
  const driver = driverView(state.driving, now, seatName);
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
    <div className="browser-chrome" data-testid="browser-chrome" data-driver={driver.live ? `${driver.kind}-live` : driver.kind}>
      <div className="browser-chrome__top">
        <TabStrip state={state} pending={pending} onCommand={run} controls={controls} />
        {trailing === undefined ? null : <div className="browser-chrome__window">{trailing}</div>}
      </div>
      <div className="browser-chrome__row">
        <AddressBar state={state} pending={pending} onCommand={run} onRefused={setRefused} onFocusPage={onFocusPage} inputRef={addressRef} />
        {canBox ? (
          <Button
            size="xs"
            variant="chrome"
            className="chrome-action"
            disabled={pending || drawing || draft !== null}
            data-testid="browser-comment-area"
            title="Draw a box on the page to comment on it"
            onClick={startBox}
          >
            <MessageSquarePlus size={12} aria-hidden />
            {drawing ? "Draw on the page" : "Comment on an area"}
          </Button>
        ) : null}
        <DriverControl state={state} now={now} seatName={seatName} pending={pending} onCommand={run} />
      </div>
      <SeatCodeNotice state={state} pending={pending} onCommand={run} />
      <NavigationBlockNotice state={state} />
      {draft === null ? null : (
        <BoxCommentComposer draft={draft} canvasName={canvasName ?? ""} nodeId={nodeId ?? ""} pending={posting} onPost={postBox} onDiscard={discardBox} />
      )}
      {refused === null ? null : (
        <p className="browser-chrome__refused" role="alert" data-testid="browser-chrome-refused">
          {refused}
        </p>
      )}
      {/* The shown tab loading: a sweep along the chrome's lower edge, where the page begins. */}
      {activeTab(state.tabs).loading ? <span className="browser-chrome__progress" aria-hidden /> : null}
    </div>
  );
}
