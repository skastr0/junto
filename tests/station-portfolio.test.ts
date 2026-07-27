import { describe, expect, it } from "vitest";
import {
  serializeCanvas,
  type CanvasDoc,
  type EtherNodeExtension,
} from "../src/shared/canvas";
import {
  STATION_PORTFOLIO_PROTOCOL,
  compileStationPortfolioBody,
  decodeStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";

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
    );
    const second = compileStationPortfolioBody(
      new Map([
        ["alpha", doc("a")],
        ["zeta", doc("z")],
      ]),
    );

    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      protocol: STATION_PORTFOLIO_PROTOCOL,
      documents: [{ name: "alpha" }, { name: "zeta" }],
    });
    expect([...decodeStationPortfolioBody(first).keys()]).toEqual([
      "alpha",
      "zeta",
    ]);
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
      });

      expect(() => decodeStationPortfolioBody(body)).toThrow(
        "runtime work projection data",
      );
      expect(() =>
        compileStationPortfolioBody(new Map([["work", projection]])),
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
      ),
    ) as {
      protocol: string;
      documents: Array<{ name: string; body: string }>;
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
  });
});
