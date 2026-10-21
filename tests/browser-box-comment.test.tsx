// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserBoxApi, BrowserBoxDraft, BrowserBoxResult, BrowserChromeState } from "../src/shared/browser-chrome";
import { initialPageDriving } from "../src/shared/page-driver";
import { initialPageTabs } from "../src/shared/page-tabs";
import { BrowserChrome } from "../src/renderer/components/browser/BrowserChrome";
import { pngDataUrl } from "../src/renderer/lib/png-data-url";

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const draft: BrowserBoxDraft = {
  shotId: "shot-1",
  rect: { x: 10, y: 20, w: 300, h: 120 },
  url: "https://docs.example.com/guide",
  width: 300,
  height: 120,
  png: SIGNATURE,
};

let host: HTMLDivElement;
let root: Root;
const state: BrowserChromeState = { tabs: initialPageTabs("https://docs.example.com/guide"), driving: initialPageDriving };

const mount = async (box: BrowserBoxApi | undefined) => {
  await act(async () => {
    root.render(
      <BrowserChrome
        state={state}
        now={0}
        seatName={() => undefined}
        onCommand={async () => ({ ok: true })}
        onFocusPage={() => undefined}
        box={box}
        sessionId="s1"
      />,
    );
  });
};
const fakeBox = (start: () => Promise<BrowserBoxResult>) => ({
  start: vi.fn(start),
  post: vi.fn(async () => ({ ok: true }) as const),
  discard: vi.fn(async () => undefined),
});
const click = async (selector: string) => {
  await act(async () => host.querySelector<HTMLButtonElement>(selector)!.click());
};
const typeInto = async (selector: string, value: string) => {
  const field = host.querySelector<HTMLTextAreaElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("pngDataUrl", () => {
  it("encodes the bytes as they are", () => {
    expect(pngDataUrl(SIGNATURE)).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(pngDataUrl(new Uint8Array(70_000)).length).toBeGreaterThan(90_000);
  });
});

describe("comment on an area", () => {
  it("offers nothing when main does not serve it", async () => {
    await mount(undefined);
    expect(host.querySelector('[data-testid="browser-comment-area"]')).toBeNull();
  });

  it("shows the staged shot before anything posts, then posts exactly that shot with the words", async () => {
    const box = fakeBox(async () => ({ kind: "drawn", draft }));
    await mount(box);
    await click('[data-testid="browser-comment-area"]');
    const composer = host.querySelector('[data-testid="box-comment-composer"]')!;
    expect(composer).not.toBeNull();
    expect(box.post).not.toHaveBeenCalled();
    const image = composer.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(pngDataUrl(SIGNATURE));
    expect(image.getAttribute("alt")).toContain("docs.example.com");
    expect(composer.textContent).toContain("This image goes with your comment");
    const postButton = [...composer.querySelectorAll("button")].find((b) => b.textContent === "Post comment")!;
    expect(postButton.disabled).toBe(true);
    await typeInto('textarea[aria-label="Comment"]', "  This heading is wrong  ");
    await act(async () => {
      composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(box.post).toHaveBeenCalledWith("s1", "shot-1", "This heading is wrong");
    expect(host.querySelector('[data-testid="box-comment-composer"]')).toBeNull();
  });

  it("drops the staged shot when discarded, and posts nothing", async () => {
    const box = fakeBox(async () => ({ kind: "drawn", draft }));
    await mount(box);
    await click('[data-testid="browser-comment-area"]');
    const discard = [...host.querySelectorAll("button")].find((b) => b.textContent === "Discard")!;
    await act(async () => discard.click());
    expect(box.discard).toHaveBeenCalledWith("s1", "shot-1");
    expect(box.post).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="box-comment-composer"]')).toBeNull();
  });

  it("keeps the shot and says why when posting is refused", async () => {
    const box = fakeBox(async () => ({ kind: "drawn", draft }));
    box.post.mockResolvedValueOnce({ ok: false, refusal: { kind: "invalid", message: "The page was closed." } } as never);
    await mount(box);
    await click('[data-testid="browser-comment-area"]');
    await typeInto('textarea[aria-label="Comment"]', "Hello");
    await act(async () => {
      host.querySelector('[data-testid="box-comment-composer"]')!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="browser-chrome-refused"]')?.textContent).toBe("The page was closed.");
    expect(host.querySelector('[data-testid="box-comment-composer"]')).not.toBeNull();
  });

  it("shows no composer when drawing ends without a box, and the refusal when the capture is refused", async () => {
    await mount(fakeBox(async () => ({ kind: "ended" })));
    await click('[data-testid="browser-comment-area"]');
    expect(host.querySelector('[data-testid="box-comment-composer"]')).toBeNull();
    await mount(fakeBox(async () => ({ kind: "refused", refusal: { kind: "invalid", message: "That box makes a shot over 2 MB: draw a smaller box." } })));
    await click('[data-testid="browser-comment-area"]');
    expect(host.querySelector('[data-testid="browser-chrome-refused"]')?.textContent).toContain("over 2 MB");
  });
});
