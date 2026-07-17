import { describe, expect, it } from "vitest";
import {
  buildBrowserAutomationNativePrompt,
} from "../src/main/vellum/browser/agent-confirmation";
import {
  BROWSER_AGENT_AUTHORITY_MAX_IN_FLIGHT,
  BROWSER_AGENT_AUTHORITY_MAX_USES,
  BROWSER_AGENT_AUTHORITY_TTL_MS,
  type BrowserAutomationConfirmation,
} from "../src/main/vellum/browser/agent-authority";
import { BROWSER_CAPABILITY_ACTIONS } from "../src/main/vellum/browser/capabilities";
import { formatNodeRef } from "../src/shared/node-ref";

const confirmation = (): BrowserAutomationConfirmation => ({
  subject: { kind: "hermes", id: "internal-subject-digest", label: "Hermes default" },
  targetCount: 2,
  targets: [
    {
      ref: formatNodeRef({ canvasName: "work", nodeId: "gmail" }),
      profile: "personal",
      exactOrigins: ["https://mail.google.com"],
    },
    {
      ref: formatNodeRef({ canvasName: "work", nodeId: "github" }),
      profile: "work",
      exactOrigins: ["https://github.com"],
    },
  ],
  actions: BROWSER_CAPABILITY_ACTIONS,
  ttlMs: BROWSER_AGENT_AUTHORITY_TTL_MS,
  maxUses: BROWSER_AGENT_AUTHORITY_MAX_USES,
  maxInFlight: BROWSER_AGENT_AUTHORITY_MAX_IN_FLIGHT,
});

describe("browser automation native confirmation", () => {
  it("renders the complete exact scope with Cancel as the safe default", () => {
    const prompt = buildBrowserAutomationNativePrompt(confirmation());

    expect(prompt).toMatchObject({
      type: "warning",
      title: "Browser Automation Access",
      message: "Allow Hermes default to control 2 browser pages?",
      buttons: ["Cancel", "Allow Access"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    expect(prompt?.detail).toContain("for 60 minutes");
    expect(prompt?.detail).toContain(`Actions: ${BROWSER_CAPABILITY_ACTIONS.join(", ")}`);
    expect(prompt?.detail).toContain("Command limit: 4096");
    expect(prompt?.detail).toContain("Concurrent commands: 4");
    expect(prompt?.detail).toContain("vellum://canvas/work?node=gmail");
    expect(prompt?.detail).toContain("Profile: personal");
    expect(prompt?.detail).toContain("Origin: https://mail.google.com");
    expect(prompt?.detail).toContain("vellum://canvas/work?node=github");
    expect(prompt?.detail).toContain("Profile: work");
    expect(prompt?.detail).toContain("Origin: https://github.com");
    expect(JSON.stringify(prompt)).not.toContain("internal-subject-digest");
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(Object.isFrozen(prompt?.buttons)).toBe(true);
  });

  it("fails closed when the declared count or exact scope is inconsistent", () => {
    expect(
      buildBrowserAutomationNativePrompt({ ...confirmation(), targetCount: 1 }),
    ).toBeUndefined();
    expect(
      buildBrowserAutomationNativePrompt({
        ...confirmation(),
        targets: [
          {
            ref: formatNodeRef({ canvasName: "work", nodeId: "gmail" }),
            profile: "personal",
            exactOrigins: ["https://mail.google.com/path"],
          },
          confirmation().targets[1]!,
        ],
      }),
    ).toBeUndefined();
  });

  it("fails closed instead of truncating a scope too large for the native prompt", () => {
    const targets = Array.from({ length: 64 }, (_, index) => ({
      ref: formatNodeRef({
        canvasName: "work",
        nodeId: `${String(index).padStart(2, "0")}-${"n".repeat(500)}`,
      }),
      profile: "default",
      exactOrigins: [
        `https://${"a".repeat(50)}.${"b".repeat(50)}.${"c".repeat(50)}.${"d".repeat(50)}.example.com`,
      ],
    }));
    expect(
      buildBrowserAutomationNativePrompt({
        ...confirmation(),
        targetCount: targets.length,
        targets,
      }),
    ).toBeUndefined();
  });
});
