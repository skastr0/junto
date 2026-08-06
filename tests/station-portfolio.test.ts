import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  serializeCanvas,
  type CanvasDoc,
  type EtherNodeExtension,
} from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import {
  STATION_PORTFOLIO_PROTOCOL,
  compileStationPortfolioBody,
  decodeStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";

const installation = (value: string) =>
  Schema.decodeUnknownSync(InstallationId)(value);

const commandInstallation = installation("install-command");
const localTopology = new Map([["local", commandInstallation]]);

const doc = (text: string): CanvasDoc => ({
  nodes: [
    {
      id: "note",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text,
    },
  ],
  edges: [],
});

const workProjectionDoc = (ether: EtherNodeExtension): CanvasDoc => ({
  nodes: [
    {
      id: "sink",
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "work",
      ether,
    },
  ],
  edges: [],
});

const actorDoc = (
  nodeId: string,
  bindingId: string,
  hostId = "local",
): CanvasDoc => ({
  nodes: [
    {
      id: nodeId,
      type: "text",
      x: 0,
      y: 0,
      width: 240,
      height: 100,
      text: "actor",
      ether: {
        entity: { kind: "agent", name: `${hostId}:codex` },
        terminal: {
          bindingId,
          launch: { kind: "harness", argv: ["codex"] },
          harness: "codex",
        },
        host: hostId,
      },
    },
  ],
  edges: [],
});

const workProjectionCases = [
  ["tasks", { tasks: { items: [] } }],
  ["requests", { requests: { items: [] } }],
  ["messages", { messages: { items: [] } }],
  ["artifacts", { artifacts: { items: [] } }],
] as const satisfies ReadonlyArray<readonly [string, EtherNodeExtension]>;

describe("station portfolio body", () => {
  it("compiles a deterministic complete set and decodes it", () => {
    const first = compileStationPortfolioBody(
      new Map([
        ["zeta", doc("z")],
        ["alpha", doc("a")],
      ]),
      new Map(),
    );
    const second = compileStationPortfolioBody(
      new Map([
        ["alpha", doc("a")],
        ["zeta", doc("z")],
      ]),
      new Map(),
    );

    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      protocol: STATION_PORTFOLIO_PROTOCOL,
      documents: [{ name: "alpha" }, { name: "zeta" }],
      actorSeats: [],
    });
    expect([...decodeStationPortfolioBody(first).documents.keys()]).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("carries a deterministic complete actor registry beside the documents", () => {
    const body = compileStationPortfolioBody(
      new Map([
        ["zeta", actorDoc("agent-z", "binding-1")],
        ["alpha", actorDoc("agent-a", "binding-1")],
      ]),
      localTopology,
    );
    const decoded = decodeStationPortfolioBody(body);

    expect(decoded.actorSeats).toHaveLength(1);
    expect(decoded.actorSeats[0]).toMatchObject({
      authorityInstallationId: commandInstallation,
      hostId: "local",
      bindingId: "binding-1",
      primaryRef: { canvasName: "alpha", nodeId: "agent-a" },
      refs: [
        { canvasName: "alpha", nodeId: "agent-a" },
        { canvasName: "zeta", nodeId: "agent-z" },
      ],
    });
    expect(compileStationPortfolioBody(
      new Map([
        ["alpha", actorDoc("agent-a", "binding-1")],
        ["zeta", actorDoc("agent-z", "binding-1")],
      ]),
      localTopology,
    )).toBe(body);
  });

  it.each(workProjectionCases)(
    "rejects valid %s projections at compile and inbound decode",
    (_key, ether) => {
      const projection = workProjectionDoc(ether);
      const body = JSON.stringify({
        protocol: STATION_PORTFOLIO_PROTOCOL,
        documents: [
          {
            name: "work",
            body: serializeCanvas(projection),
          },
        ],
        actorSeats: [],
      });

      expect(() => decodeStationPortfolioBody(body)).toThrow(
        "runtime work projection data",
      );
      expect(() =>
        compileStationPortfolioBody(
          new Map([["work", projection]]),
          new Map(),
        ),
      ).toThrow("runtime work projection data");
    },
  );

  it("rejects alternate ordering, unknown fields, and duplicate names", () => {
    const canonical = JSON.parse(
      compileStationPortfolioBody(
        new Map([
          ["alpha", doc("a")],
          ["zeta", doc("z")],
        ]),
        new Map(),
      ),
    ) as {
      protocol: string;
      documents: Array<{ name: string; body: string }>;
      actorSeats: Array<unknown>;
    };

    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          ...canonical,
          documents: [...canonical.documents].reverse(),
        }),
      )
    ).toThrow("strictly sorted");
    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({ ...canonical, legacyPath: "/tmp/frame" }),
      )
    ).toThrow("portfolio contract");
    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          ...canonical,
          documents: [
            canonical.documents[0],
            canonical.documents[0],
          ],
        }),
      )
    ).toThrow("strictly sorted");
    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          protocol: "vellum-command/station-portfolio/v1",
          documents: canonical.documents,
        }),
      )
    ).toThrow("portfolio contract");
  });

  it("strictly rejects altered, excess, incomplete, and unsorted actor records", () => {
    const canonical = JSON.parse(
      compileStationPortfolioBody(
        new Map([
          ["alpha", actorDoc("agent-a", "binding-1")],
          ["zeta", actorDoc("agent-z", "binding-1")],
        ]),
        localTopology,
      ),
    ) as {
      protocol: string;
      documents: Array<{ name: string; body: string }>;
      actorSeats: Array<{
        seatId: string;
        authorityInstallationId: string;
        hostId: string;
        bindingId: string;
        agentKey: string;
        harness: string;
        launch?: unknown;
        sessionId?: string;
        primaryRef: { canvasName: string; nodeId: string };
        refs: Array<{ canvasName: string; nodeId: string }>;
      }>;
    };
    const seat = canonical.actorSeats[0]!;

    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          ...canonical,
          actorSeats: [{ ...seat, legacyNodeIdentity: "agent-a" }],
        }),
      )
    ).toThrow(/is unexpected|Unexpected key|invalid/i);
    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          ...canonical,
          actorSeats: [{ ...seat, seatId: `seat_${"0".repeat(64)}` }],
        }),
      )
    ).toThrow("does not match");
    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({ ...canonical, actorSeats: [] }),
      )
    ).toThrow("unresolved host");
    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          ...canonical,
          actorSeats: [{
            ...seat,
            primaryRef: seat.refs[1],
            refs: [...seat.refs].reverse(),
          }],
        }),
      )
    ).toThrow("not strictly sorted");
    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          ...canonical,
          actorSeats: [{
            ...seat,
            primaryRef: seat.refs[1],
          }],
        }),
      )
    ).toThrow("primaryRef");
  });

  it("rejects actor seats that are not strictly sorted", () => {
    const canonical = JSON.parse(
      compileStationPortfolioBody(
        new Map([
          ["alpha", actorDoc("agent-a", "binding-a")],
          ["zeta", actorDoc("agent-z", "binding-z")],
        ]),
        localTopology,
      ),
    ) as {
      protocol: string;
      documents: Array<{ name: string; body: string }>;
      actorSeats: Array<unknown>;
    };
    expect(canonical.actorSeats).toHaveLength(2);

    expect(() =>
      decodeStationPortfolioBody(
        JSON.stringify({
          ...canonical,
          actorSeats: [...canonical.actorSeats].reverse(),
        }),
      )
    ).toThrow("strictly sorted by seatId");
  });
});
