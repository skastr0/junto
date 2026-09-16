import { beforeEach, describe, expect, it } from "vitest";
import {
  TrustedRendererRefused,
  getTrustedMainWebContents,
  setTrustedMainWebContents,
  trustedRendererIpc,
} from "../src/main/junto/trusted-main-webcontents";

const trustedUrl = "http://localhost:5173/";

const fakeContents = (id: number, url = trustedUrl) => ({
  id,
  destroyed: false,
  isDestroyed() {
    return this.destroyed;
  },
  getURL() {
    return url;
  },
});

const origin = {
  initialUrl: trustedUrl,
  allows: (url: string | undefined) => url?.startsWith("http://localhost:5173/") ?? false,
};

beforeEach(() => setTrustedMainWebContents(undefined));

describe("trusted main WebContents identity", () => {
  it("requires both object identity and its committed authority", () => {
    const trusted = fakeContents(1);
    setTrustedMainWebContents(trusted as never, origin);
    expect(getTrustedMainWebContents()).toBe(trusted);

    const forged = fakeContents(1);
    let handler: ((event: { sender: unknown }) => unknown) | undefined;
    const raw = {
      handle: (_channel: string, callback: typeof handler) => {
        handler = callback;
      },
    };
    trustedRendererIpc(raw as never).handle("danger", () => "accepted");
    expect(handler?.({ sender: trusted })).toBe("accepted");
    expect(() => handler?.({ sender: forged })).toThrow(TrustedRendererRefused);
  });

  it("revokes a trusted object when its URL changes after commit", () => {
    let currentUrl = trustedUrl;
    const contents = {
      id: 1,
      isDestroyed: () => false,
      getURL: () => currentUrl,
    };
    setTrustedMainWebContents(contents as never, origin);
    expect(getTrustedMainWebContents()).toBe(contents);
    currentUrl = "https://attacker.invalid/";
    expect(getTrustedMainWebContents()).toBeUndefined();
  });
});
