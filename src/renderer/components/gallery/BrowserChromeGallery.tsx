import { useEffect, useMemo, useState } from "react";
import { asNodeId } from "@shared/model";
import type { BrowserChromeState } from "@shared/browser-chrome";
import { Eyebrow } from "../ui";
import { BrowserChrome } from "../browser/BrowserChrome";
import {
  makeLocalBrowserChrome,
  runChromeCommand,
  useBrowserChromeState,
} from "../../lib/browser-chrome-source";

/**
 * Dev gallery for the page chrome: a page driven through the local source
 * (the shared tab and driver reducers). Route: `#/gallery/browser-chrome`.
 * Open and close tabs, type an address (a refused one says why), take the
 * page over and hand it back; the seat buttons stand for a seat acting.
 */
const ADA = asNodeId("seat-ada");
const NAMES: Readonly<Record<string, string>> = { "seat-ada": "product-modals" };
const SESSION = "gallery-page";

export function BrowserChromeGallery() {
  const chrome = useMemo(() => makeLocalBrowserChrome("https://example.com/"), []);
  const state: BrowserChromeState | undefined = useBrowserChromeState(chrome, SESSION);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);
  return (
    <main className="mx-auto grid max-w-3xl gap-4 p-6 text-ink" data-testid="browser-chrome-gallery">
      <h1 className="m-0 text-lg font-semibold">Page chrome</h1>
      <section className="grid gap-2">
        <Eyebrow>The chrome on a page</Eyebrow>
        <div className="overflow-hidden rounded-lg border border-stroke bg-raise">
          {state === undefined ? null : (
            <BrowserChrome
              state={state}
              now={now}
              seatName={(id) => NAMES[id]}
              onCommand={(command) => runChromeCommand(chrome, SESSION, command)}
            />
          )}
          <div className="grid h-40 place-items-center text-dim">the page</div>
        </div>
      </section>
      <section className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border border-stroke px-2 py-1 text-body"
          onClick={() => chrome.seat(SESSION, { kind: "seat-start", nodeId: ADA, at: Date.now() })}
        >
          A seat starts acting
        </button>
        <button
          type="button"
          className="rounded border border-stroke px-2 py-1 text-body"
          onClick={() => chrome.seat(SESSION, { kind: "seat-end", nodeId: ADA, at: Date.now() })}
        >
          The seat finishes
        </button>
      </section>
    </main>
  );
}
