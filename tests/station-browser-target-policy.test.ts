import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { StationBrowserRequest } from "../src/shared/station-browser";
import { makeStationBrowserTargetPolicy } from "../src/main/vellum/browser/station-target-policy";

const stationId = "remote-a";
const agentRef = "vellum://canvas/work?node=agent-1";
const pageRef = "vellum://canvas/work?node=page-1";

const agentNode = (): CanvasDoc["nodes"][number] => ({
  id: "agent-1",
  type: "text",
  text: "agent",
  x: 0,
  y: 0,
  width: 120,
  height: 48,
  ether: {
    entity: { kind: "agent", name: "remote-a:default" },
    host: stationId,
  },
});

const pageNode = (
  changes: Readonly<{
    host?: string;
    profile?: string;
    url?: string;
  }> = {},
): CanvasDoc["nodes"][number] => ({
  id: "page-1",
  type: "link",
  url: changes.url ?? "https://github.com/",
  x: 200,
  y: 0,
  width: 120,
  height: 48,
  ether: {
    entity: { kind: "page" },
    browser: { profile: changes.profile ?? "synthetic" },
    host: changes.host ?? stationId,
  },
});

const taskNode = (): CanvasDoc["nodes"][number] => ({
  id: "task-1",
  type: "text",
  text: "task",
  x: 100,
  y: 100,
  width: 120,
  height: 48,
  ether: { entity: { kind: "task" } },
});

const canvas = (
  changes: Readonly<{
    edges?: CanvasDoc["edges"];
    page?: CanvasDoc["nodes"][number];
    extraNodes?: CanvasDoc["nodes"];
  }> = {},
): CanvasDoc => ({
  nodes: [
    agentNode(),
    changes.page ?? pageNode(),
    ...(changes.extraNodes ?? []),
  ],
  edges:
    changes.edges ??
    [{ id: "edge-1", fromNode: "agent-1", toNode: "page-1" }],
});

const request = (
  changes: Partial<StationBrowserRequest> = {},
): StationBrowserRequest => ({
  version: 1,
  requestId: "request-1",
  originStationId: "command-a",
  targetStationId: stationId,
  authority: "agent-edge",
  agentRef,
  action: "state",
  pageRef,
  session: {
    hostId: stationId,
    sessionId: "session-1",
    generation: "generation-1",
  },
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_030_000,
  nonce: "nonce-1",
  ...changes,
});

const makePolicy = (
  changes: Partial<Parameters<typeof makeStationBrowserTargetPolicy>[0]> = {},
) =>
  makeStationBrowserTargetPolicy({
    stationId,
    readCanvas: async (name) => (name === "work" ? canvas() : undefined),
    admitStation: async () => ({ ok: true }),
    browserReady: () => true,
    currentGeneration: () => "generation-1",
    now: () => 1_700_000_000_000,
    ...changes,
  });

describe("Remote station browser target policy", () => {
  it("admits only the exact direct agent-to-page browser.automate edge", async () => {
    const policy = makePolicy();
    const signedRequest = request();
    const verification = await policy.verification(signedRequest);

    expect(verification).toMatchObject({
      stationId,
      role: "remote",
      browserReady: true,
      now: 1_700_000_000_000,
    });
    expect(verification.resolvePage(pageRef)).toEqual({
      hostId: stationId,
      edgeAllowed: true,
      policyAllowed: true,
    });
    expect(verification.allowAction(signedRequest)).toBe(true);
    expect(verification.currentGeneration(signedRequest)).toBe("generation-1");
    await expect(policy.discoverPages(signedRequest)).resolves.toEqual([
      { pageRef, hostId: stationId },
    ]);
  });

  it.each([
    {
      name: "has no edge",
      doc: canvas({ edges: [] }),
    },
    {
      name: "is connected only through another node",
      doc: canvas({
        extraNodes: [taskNode()],
        edges: [
          { id: "edge-agent-task", fromNode: "agent-1", toNode: "task-1" },
          { id: "edge-task-page", fromNode: "task-1", toNode: "page-1" },
        ],
      }),
    },
  ])("denies a page when the agent $name", async ({ doc }) => {
    const policy = makePolicy({ readCanvas: async () => doc });
    const signedRequest = request();
    const verification = await policy.verification(signedRequest);

    expect(verification.browserReady).toBe(true);
    expect(verification.resolvePage(pageRef)).toBeUndefined();
    expect(verification.allowAction(signedRequest)).toBe(false);
    await expect(policy.discoverPages(signedRequest)).resolves.toEqual([]);
  });

  it("denies a request routed to another target station", async () => {
    const signedRequest = request({ targetStationId: "remote-b" });
    const verification = await makePolicy().verification(signedRequest);

    expect(verification.browserReady).toBe(false);
    expect(verification.resolvePage(pageRef)).toBeUndefined();
    expect(verification.allowAction(signedRequest)).toBe(false);
    expect(verification.currentGeneration(signedRequest)).toBeUndefined();
  });

  it.each([
    {
      name: "page host is not this station",
      page: pageNode({ host: "remote-b" }),
    },
    {
      name: "page URL is not admitted by the public-web policy",
      page: pageNode({ url: "http://127.0.0.1/admin" }),
    },
    {
      name: "page profile is not canonical",
      page: pageNode({ profile: "../escape" }),
    },
  ])("denies the page when its $name", async ({ page }) => {
    const policy = makePolicy({
      readCanvas: async () => canvas({ page }),
    });
    const signedRequest = request();
    const verification = await policy.verification(signedRequest);

    expect(verification.resolvePage(pageRef)).toMatchObject({
      edgeAllowed: true,
      policyAllowed: false,
    });
    expect(verification.allowAction(signedRequest)).toBe(false);
    await expect(policy.discoverPages(signedRequest)).resolves.toEqual([]);
  });

  it.each([
    {
      name: "station mirror admission is stale",
      changes: {
        admitStation: async () => ({ ok: false }),
      },
    },
    {
      name: "local browser capability is not ready",
      changes: {
        browserReady: () => false,
      },
    },
    {
      name: "station freshness check fails closed",
      changes: {
        admitStation: async () => {
          throw new Error("station unavailable");
        },
      },
    },
    {
      name: "pulled canvas cannot be read",
      changes: {
        readCanvas: async () => {
          throw new Error("canvas unavailable");
        },
      },
    },
  ])("fails closed when $name", async ({ changes }) => {
    const signedRequest = request();
    const verification = await makePolicy(changes).verification(signedRequest);

    expect(verification.browserReady).toBe(false);
    expect(verification.resolvePage(pageRef)).toBeUndefined();
    expect(verification.allowAction(signedRequest)).toBe(false);
    await expect(makePolicy(changes).discoverPages(signedRequest)).resolves.toEqual([]);
  });

  it("never accepts operator-ui authority on a Remote target", async () => {
    const { agentRef: _agentRef, ...withoutAgentRef } = request();
    const operatorRequest: StationBrowserRequest = {
      ...withoutAgentRef,
      authority: "operator-ui",
    };
    const verification = await makePolicy().verification(operatorRequest);

    expect(verification.browserReady).toBe(false);
    expect(verification.allowAction(operatorRequest)).toBe(false);
    await expect(makePolicy().discoverPages(operatorRequest)).resolves.toEqual([]);
  });

  it("binds generation and action authority to the exact inspected request", async () => {
    const generationRequests: StationBrowserRequest[] = [];
    const policy = makePolicy({
      currentGeneration: (candidate) => {
        generationRequests.push(candidate);
        return "generation-1";
      },
    });
    const signedRequest = request();
    const verification = await policy.verification(signedRequest);
    const canonicalCopy = request();
    const differentNonce = request({ nonce: "nonce-2" });

    expect(verification.currentGeneration(canonicalCopy)).toBe("generation-1");
    expect(verification.allowAction(canonicalCopy)).toBe(true);
    expect(verification.currentGeneration(differentNonce)).toBeUndefined();
    expect(verification.allowAction(differentNonce)).toBe(false);
    expect(generationRequests).toEqual([canonicalCopy]);
  });

  it("re-reads the current Remote canvas for each verification or discovery", async () => {
    let current = canvas();
    let reads = 0;
    const policy = makePolicy({
      readCanvas: async () => {
        reads += 1;
        return current;
      },
    });
    const signedRequest = request();

    const admitted = await policy.verification(signedRequest);
    expect(admitted.allowAction(signedRequest)).toBe(true);

    current = canvas({ edges: [] });
    const revoked = await policy.verification(signedRequest);
    expect(revoked.allowAction(signedRequest)).toBe(false);
    await expect(policy.discoverPages(signedRequest)).resolves.toEqual([]);
    expect(reads).toBe(3);
  });
});
