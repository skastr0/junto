import { describe, expect, it, vi } from "vitest";
import { createTrustedRendererNavigation } from "../src/main/vellum/trusted-renderer-navigation";

const trustedUrl = "http://localhost:5173/";

const fixture = () => {
  let currentUrl = trustedUrl;
  let available = true;
  let trusted = true;
  const rejected: string[] = [];
  const documentStarted = vi.fn();
  const trustedDocumentCommitted = vi.fn();
  const lifecycle = createTrustedRendererNavigation({
    origin: {
      initialUrl: trustedUrl,
      allows: (candidate) => candidate?.startsWith(trustedUrl) ?? false,
    },
    currentUrl: () => currentUrl,
    available: () => available,
    trust: () => {
      trusted = true;
    },
    revoke: () => {
      trusted = false;
    },
    rejectCommittedUrl: (url) => rejected.push(url),
    documentStarted,
    trustedDocumentCommitted,
  });
  return {
    lifecycle,
    trusted: () => trusted,
    rejected,
    documentStarted,
    trustedDocumentCommitted,
    setUrl: (url: string) => {
      currentUrl = url;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
};

describe("trusted renderer navigation lifecycle", () => {
  it("preserves the committed document when off-authority navigation is denied", () => {
    const f = fixture();
    const event = { preventDefault: vi.fn() };

    f.lifecycle.willNavigate(event, "https://attacker.invalid/");

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(f.trusted()).toBe(true);
    expect(f.documentStarted).not.toHaveBeenCalled();
  });

  it("revokes then re-mints trust for a same-authority document generation", () => {
    const f = fixture();
    const event = { preventDefault: vi.fn() };

    f.lifecycle.willNavigate(event, `${trustedUrl}reload`);
    f.lifecycle.didStartNavigation(false, true);
    expect(f.trusted()).toBe(false);
    expect(f.documentStarted).toHaveBeenCalledOnce();

    f.setUrl(`${trustedUrl}reload`);
    f.lifecycle.didFinishLoad();
    expect(f.trusted()).toBe(true);
    expect(f.trustedDocumentCommitted).toHaveBeenCalledOnce();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("mints IPC trust on did-navigate before did-finish-load", () => {
    const f = fixture();
    f.lifecycle.didStartNavigation(false, true);
    expect(f.trusted()).toBe(false);

    f.lifecycle.didNavigate(`${trustedUrl}app`);
    expect(f.trusted()).toBe(true);
    // Mount challenge waits for load-complete — only IPC trust is early.
    expect(f.trustedDocumentCommitted).not.toHaveBeenCalled();

    f.setUrl(`${trustedUrl}app`);
    f.lifecycle.didFinishLoad();
    expect(f.trusted()).toBe(true);
    expect(f.trustedDocumentCommitted).toHaveBeenCalledOnce();
  });

  it("rejects a hostile did-navigate commit without waiting for finish-load", () => {
    const f = fixture();
    f.lifecycle.didStartNavigation(false, true);
    f.lifecycle.didNavigate("https://attacker.invalid/");
    expect(f.trusted()).toBe(false);
    expect(f.rejected).toEqual(["https://attacker.invalid/"]);
  });

  it("restores the prior document after a denied redirect or failed load", () => {
    const redirect = fixture();
    redirect.lifecycle.didFinishLoad();
    redirect.lifecycle.didStartNavigation(false, true);
    expect(redirect.trusted()).toBe(false);
    const event = { preventDefault: vi.fn() };
    redirect.lifecycle.willRedirect(event, true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(redirect.trusted()).toBe(true);

    const failed = fixture();
    failed.lifecycle.didFinishLoad();
    failed.lifecycle.didStartNavigation(false, true);
    failed.lifecycle.didFailLoad(true);
    expect(failed.trusted()).toBe(true);
  });

  it("does not revoke for in-place navigation and rejects a hostile committed URL", () => {
    const f = fixture();
    f.lifecycle.didStartNavigation(true, true);
    expect(f.trusted()).toBe(true);

    f.setUrl("https://attacker.invalid/");
    f.lifecycle.didFinishLoad();
    expect(f.trusted()).toBe(false);
    expect(f.rejected).toEqual(["https://attacker.invalid/"]);
  });

  it("revokes on renderer loss and never trusts an unavailable window", () => {
    const f = fixture();
    f.lifecycle.documentLost();
    expect(f.trusted()).toBe(false);
    expect(f.documentStarted).toHaveBeenCalledOnce();
    f.setAvailable(false);
    f.lifecycle.didFinishLoad();
    expect(f.trusted()).toBe(false);
  });

  it("never restores trust when the initial document failed before a commit", () => {
    const f = fixture();
    f.lifecycle.documentLost();
    f.lifecycle.didStartNavigation(false, true);
    f.lifecycle.didFailLoad(true);
    expect(f.trusted()).toBe(false);
  });
});
