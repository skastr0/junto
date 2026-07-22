import { describe, expect, it } from "vitest";
import {
  TRUSTED_RENDERER_URL,
  isRendererPreloadCandidate,
  resolveTrustedRendererOrigin,
} from "../src/shared/trusted-renderer-origin";

describe("trusted renderer boot authority", () => {
  it("uses only the fixed packaged renderer document", () => {
    const authority = resolveTrustedRendererOrigin(true, "https://attacker.invalid/");
    expect(authority.initialUrl).toBe(TRUSTED_RENDERER_URL);
    expect(authority.allows(TRUSTED_RENDERER_URL)).toBe(true);
    expect(authority.allows("vellum-app://renderer/other.html")).toBe(false);
    expect(authority.allows("https://attacker.invalid/")).toBe(false);
  });

  it("admits one explicit loopback development authority", () => {
    const authority = resolveTrustedRendererOrigin(false, "http://localhost:5173/");
    expect(authority.initialUrl).toBe("http://localhost:5173/");
    expect(authority.allows("http://localhost:5173/")).toBe(true);
    expect(authority.allows("http://localhost:5173/src/main.tsx")).toBe(false);
    expect(authority.allows("http://localhost:5174/")).toBe(false);
    expect(authority.allows("http://127.0.0.1:5173/")).toBe(false);
  });

  it.each([
    "https://attacker.invalid/",
    "http://attacker@localhost:5173/",
    "http://localhost.attacker.invalid:5173/",
    "http://localhost:5173/app",
    "http://localhost:5173/?next=https://attacker.invalid",
    "http://[::1]:5173/",
    "http://2130706433:5173/",
    "file:///tmp/index.html",
    "http://localhost/",
    "http://127.0.0.1:5173/",
  ])("rejects hostile or ambiguous development input: %s", (candidate) => {
    expect(() => resolveTrustedRendererOrigin(false, candidate)).toThrow(/ELECTRON_RENDERER_URL/u);
  });

  it("lets preload expose only fixed or strict loopback candidate locations", () => {
    expect(isRendererPreloadCandidate(TRUSTED_RENDERER_URL)).toBe(true);
    expect(isRendererPreloadCandidate("https://localhost:5173/")).toBe(true);
    expect(isRendererPreloadCandidate("https://127.0.0.1:4173/app")).toBe(false);
    expect(isRendererPreloadCandidate("https://attacker.invalid/")).toBe(false);
    expect(isRendererPreloadCandidate("http://attacker@localhost:5173/")).toBe(false);
    expect(isRendererPreloadCandidate("http://localhost.attacker.invalid:5173/")).toBe(false);
  });
});
