import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  BROWSER_AUTOMATION_HERDR_AGENTS,
  type BrowserAutomationErrorCode,
} from "../src/shared/ipc";
import {
  BROWSER_AUTOMATION_AGENT_OPTIONS,
  BROWSER_AUTOMATION_UI_TEXT_MAX_BYTES,
  boundedBrowserAutomationText,
  browserAutomationEligibility,
  browserAutomationErrorCopy,
  browserAutomationFailureNotice,
  browserAutomationNodeRef,
  buildBrowserAutomationEnableInput,
  isCurrentBrowserAutomationGrant,
} from "../src/renderer/lib/browser-automation-ui";

const node = (
  id: string,
  ether: NonNullable<CanvasNode["ether"]>,
): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether,
});

const localHermes = (id = "agent/one"): CanvasNode =>
  node(id, { entity: { kind: "agent", name: "local:default" } });

const localHerdr = (id = "pane/one"): CanvasNode =>
  node(id, {
    entity: { kind: "herdr" },
    herdr: {
      host: "local",
      session: null,
      paneId: "workspace:pane-1",
      workspaceId: "workspace-1",
      tabId: "tab-1",
    },
  });

describe("browser automation UI boundary", () => {
  it("offers enablement only for local Hermes and local default-session Herdr nodes", () => {
    expect(browserAutomationEligibility(localHermes())).toEqual({
      eligible: true,
      kind: "hermes",
    });
    expect(browserAutomationEligibility(localHerdr())).toEqual({
      eligible: true,
      kind: "herdr",
    });
    expect(
      browserAutomationEligibility(
        node("remote-agent", {
          entity: { kind: "agent", name: "remote-a:default" },
        }),
      ),
    ).toMatchObject({ eligible: false, reason: "local_only" });
    expect(
      browserAutomationEligibility(
        node("remote-pane", {
          entity: { kind: "herdr" },
          herdr: { host: "remote-a", session: null, paneId: "pane-1" },
        }),
      ),
    ).toMatchObject({ eligible: false, reason: "local_only" });
    expect(
      browserAutomationEligibility(
        node("named-session", {
          entity: { kind: "herdr" },
          herdr: { host: "local", session: "named", paneId: "pane-1" },
        }),
      ),
    ).toMatchObject({ eligible: false, reason: "default_session_only" });
    expect(
      browserAutomationEligibility(
        node("incomplete-pane", {
          entity: { kind: "herdr" },
          herdr: { host: "local", session: null },
        }),
      ),
    ).toMatchObject({ eligible: false, reason: "incomplete_binding" });
  });

  it("sends exact locator-only request keys and discloses no authority inputs", () => {
    const hermes = buildBrowserAutomationEnableInput({
      canvasName: "work",
      node: localHermes(),
    });
    const herdr = buildBrowserAutomationEnableInput({
      canvasName: "work",
      node: localHerdr(),
      agent: "codex",
    });

    expect(Object.keys(hermes ?? {}).sort()).toEqual(["kind", "ref"]);
    expect(Object.keys(herdr ?? {}).sort()).toEqual(["agent", "kind", "ref"]);
    for (const input of [hermes, herdr]) {
      const serialized = JSON.stringify(input);
      for (const forbidden of [
        "actions",
        "capability",
        "controlHome",
        "exactOrigins",
        "maxInFlight",
        "maxUses",
        "profile",
        "subject",
        "targets",
        "token",
        "ttlMs",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it("derives canonical refs from the current canvas and node identity", () => {
    const agent = localHermes("folder/page 100%");
    expect(
      buildBrowserAutomationEnableInput({ canvasName: "alpha", node: agent }),
    ).toEqual({
      kind: "hermes",
      ref: "vellum://canvas/alpha?node=folder%2Fpage%20100%25",
    });
    expect(
      buildBrowserAutomationEnableInput({ canvasName: "beta", node: agent }),
    ).toEqual({
      kind: "hermes",
      ref: "vellum://canvas/beta?node=folder%2Fpage%20100%25",
    });
    expect(
      buildBrowserAutomationEnableInput({ canvasName: "../private", node: agent }),
    ).toBeUndefined();

    const alphaRef = browserAutomationNodeRef("alpha", agent);
    const betaRef = browserAutomationNodeRef("beta", agent);
    if (alphaRef === undefined) throw new Error("alpha ref fixture is invalid");
    const grant = {
      automationId: "00000000-0000-4000-8000-000000000001",
      kind: "hermes" as const,
      ref: alphaRef,
      issuedAt: 1,
      expiresAt: 2,
    };
    expect(isCurrentBrowserAutomationGrant(grant, alphaRef)).toBe(true);
    expect(isCurrentBrowserAutomationGrant(grant, betaRef)).toBe(false);
    expect(isCurrentBrowserAutomationGrant(grant, undefined)).toBe(false);
  });

  it("uses only the fixed shared Herdr agent set", () => {
    expect(BROWSER_AUTOMATION_AGENT_OPTIONS).toBe(BROWSER_AUTOMATION_HERDR_AGENTS);
    expect([...BROWSER_AUTOMATION_AGENT_OPTIONS]).toEqual([
      "claude",
      "codex",
      "hermes",
      "kimi",
      "opencode",
    ]);
    expect(
      buildBrowserAutomationEnableInput({
        canvasName: "work",
        node: localHerdr(),
        agent: "unknown" as never,
      }),
    ).toBeUndefined();
  });

  it("maps failures to fixed bounded copy and treats native cancellation as neutral", () => {
    const codes: ReadonlyArray<BrowserAutomationErrorCode> = [
      "invalid",
      "cancelled",
      "capacity",
      "delivery_failed",
      "closed",
      "not_found",
    ];
    for (const operation of ["list", "enable", "revoke"] as const) {
      for (const code of codes) {
        const copy = browserAutomationErrorCopy(operation, code);
        expect(copy).toBeTypeOf("string");
        expect(new TextEncoder().encode(copy).byteLength).toBeLessThanOrEqual(
          BROWSER_AUTOMATION_UI_TEXT_MAX_BYTES,
        );
      }
    }
    expect(browserAutomationFailureNotice("enable", "cancelled")).toEqual({
      text: "Access was not enabled.",
      tone: "neutral",
    });
    expect(browserAutomationFailureNotice("revoke", "not_found")).toBeUndefined();
    const raw = "SECRET stack trace /Users/operator/private";
    expect(browserAutomationErrorCopy("enable", new Error(raw))).toBe(
      "Browser automation is temporarily unavailable.",
    );
    expect(browserAutomationErrorCopy("enable", raw)).not.toContain(raw);
    expect(new TextEncoder().encode(boundedBrowserAutomationText("x".repeat(900))).byteLength).toBe(
      BROWSER_AUTOMATION_UI_TEXT_MAX_BYTES,
    );
  });
});
