import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  STATION_PORTFOLIO_PROTOCOL,
  StationPortfolioError,
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

  it("rejects embedded work state instead of sanitizing it into intent", () => {
    const body = JSON.stringify({
      protocol: STATION_PORTFOLIO_PROTOCOL,
      documents: [
        {
          name: "work",
          body: JSON.stringify({
            nodes: [
              {
                id: "tasks",
                type: "text",
                x: 0,
                y: 0,
                width: 240,
                height: 100,
                text: "tasks",
                ether: {
                  entity: { kind: "task" },
                  tasks: { items: [] },
                },
              },
            ],
            edges: [],
          }),
        },
      ],
    });

    expect(() => decodeStationPortfolioBody(body)).toThrow(
      StationPortfolioError,
    );
  });

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
