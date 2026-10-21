import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Hand, Plus, RotateCw, Undo2, X } from "lucide-react";
import type { BrowserChromeState } from "@shared/browser-chrome";
import type { BrowserTabId } from "@shared/browser-tab";
import { activeTab } from "@shared/page-tabs";
import type { ChromeCommand } from "../../lib/browser-chrome-source";
import { addressTarget, driverView, refusalLine, tabLabel, takeoverOffer } from "../../lib/browser-chrome-model";
import type { BrowserChromeOutcome } from "@shared/browser-chrome";
import { Button, IconButton, Input, StatusDot } from "../ui";
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

/** The tabs in order; the active one is marked. Closing is hidden on the last tab. */
export function TabStrip({
  state,
  pending,
  onCommand,
}: {
  readonly state: BrowserChromeState;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
}) {
  const { tabs, active } = state.tabs;
  const only = tabs.length === 1;
  return (
    <div className="tab-strip" role="tablist" aria-label="Tabs" data-testid="browser-tabs">
      {tabs.map((tab) => {
        const label = tabLabel(tab);
        return (
          <div key={tab.id} className="tab-strip__tab" data-active={tab.id === active ? "true" : undefined} data-loading={tab.loading ? "true" : undefined}>
            <button
              type="button"
              role="tab"
              aria-selected={tab.id === active}
              className="tab-strip__label"
              title={tab.url === "" ? label : `${label}\n${tab.url}`}
              disabled={pending}
              onClick={() => onCommand({ kind: "activateTab", tab: tab.id as BrowserTabId })}
            >
              {tab.loading ? <span className="tab-strip__loading" aria-hidden /> : null}
              <span className="truncate">{label}</span>
              {tab.loading ? <span className="sr-only">, loading</span> : null}
            </button>
            {only ? null : (
              <IconButton
                aria-label={`Close ${label}`}
                title="Close tab"
                size="xs"
                disabled={pending}
                onClick={() => onCommand({ kind: "closeTab", tab: tab.id as BrowserTabId })}
              >
                <X size={11} />
              </IconButton>
            )}
          </div>
        );
      })}
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
}: {
  readonly state: BrowserChromeState;
  readonly pending: boolean;
  readonly onCommand: (command: ChromeCommand) => void;
  readonly onRefused: (message: string) => void;
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
        if (target.ok) onCommand({ kind: "goto", url: target.url });
        else onRefused(target.message);
      }}
    >
      <IconButton aria-label="Back" title="Back" size="sm" disabled={pending || !tab.canGoBack} onClick={() => onCommand({ kind: "traverse", step: "back" })}>
        <ArrowLeft size={14} />
      </IconButton>
      <IconButton aria-label="Forward" title="Forward" size="sm" disabled={pending || !tab.canGoForward} onClick={() => onCommand({ kind: "traverse", step: "forward" })}>
        <ArrowRight size={14} />
      </IconButton>
      <IconButton aria-label="Reload" title="Reload" size="sm" disabled={pending} onClick={() => onCommand({ kind: "traverse", step: "reload" })}>
        <RotateCw size={14} />
      </IconButton>
      <Input
        dense
        aria-label="Address"
        placeholder="Search or type an address"
        spellCheck={false}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
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
export function BrowserChrome({
  state,
  now,
  seatName,
  onCommand,
  trailing,
}: {
  readonly state: BrowserChromeState;
  readonly now: number;
  readonly seatName: (nodeId: string) => string | undefined;
  readonly onCommand: (command: ChromeCommand) => Promise<BrowserChromeOutcome>;
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
  return (
    <div className="browser-chrome" data-testid="browser-chrome">
      <TabStrip state={state} pending={pending} onCommand={run} />
      <div className="browser-chrome__row">
        <AddressBar state={state} pending={pending} onCommand={run} onRefused={setRefused} />
        <DriverMark state={state} now={now} seatName={seatName} />
        <TakeoverControl state={state} pending={pending} onCommand={run} />
        {trailing}
      </div>
      {refused === null ? null : (
        <p className="browser-chrome__refused" role="alert" data-testid="browser-chrome-refused">
          {refused}
        </p>
      )}
    </div>
  );
}
