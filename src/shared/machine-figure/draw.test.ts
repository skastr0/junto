import { describe, expect, it } from "vitest";
import { THEME_MODES } from "../theme";
import {
  MACHINE_FORMS,
  machineDetailFor,
  machineFigureKey,
  machineFigureSvg,
  machineGenome,
  resolveMachineForm,
  type MachineFigureRequest,
  type MachineFigureState,
} from "./index";

const idle: MachineFigureState = { reach: "reachable", install: "idle", missingHarness: false, missingSecrets: 0, seats: 0 };
const request = (over: Partial<MachineFigureRequest> = {}): MachineFigureRequest => ({
  name: "mac-mini",
  form: "mac-mini",
  isThisMachine: false,
  state: idle,
  mode: "dark",
  detail: "rich",
  ...over,
});

const STATES: ReadonlyArray<MachineFigureState> = [
  idle,
  { ...idle, seats: 9 },
  { ...idle, setUp: false, reach: "unknown" },
  { ...idle, reach: "unreachable", seats: 2 },
  { ...idle, install: "sending", step: 2 },
  { ...idle, install: "updating", step: 5 },
  { ...idle, install: "needs-update", missingHarness: true, missingSecrets: 3 },
];

describe("machine figure", () => {
  it("draws every form, state, mode, tier and frame as a clean document", () => {
    for (const form of MACHINE_FORMS) {
      for (const state of STATES) {
        for (const mode of THEME_MODES) {
          for (const detail of ["glyph", "card", "rich"] as const) {
            for (const frame of ["bare", "tile"] as const) {
              const svg = machineFigureSvg(request({ form, state, mode, detail, frame, isThisMachine: true }));
              expect(svg.startsWith("<svg ")).toBe(true);
              expect(svg.endsWith("</svg>")).toBe(true);
              expect(svg).not.toMatch(/NaN|undefined|Infinity/);
              expect(svg).not.toContain(String.fromCharCode(0xb7));
            }
          }
        }
      }
    }
  });

  it("is deterministic, and its key changes exactly when the drawing may", () => {
    expect(machineFigureSvg(request())).toBe(machineFigureSvg(request()));
    expect(machineFigureKey(request())).toBe(machineFigureKey(request()));
    for (const state of STATES.slice(1)) {
      expect(machineFigureKey(request({ state }))).not.toBe(machineFigureKey(request()));
    }
    // The figure shows that a secret is missing, never how many or which.
    expect(machineFigureKey(request({ state: { ...idle, missingSecrets: 1 } }))).toBe(
      machineFigureKey(request({ state: { ...idle, missingSecrets: 4 } })),
    );
  });

  it("keeps identity apart from state", () => {
    expect(machineGenome("mac-mini")).toEqual(machineGenome(" Mac-Mini "));
    expect(machineGenome("mac-mini", "pink").bodyHue).toBe("pink");
    const body = (svg: string): string | undefined => /<rect width="100" height="100" fill="(#[0-9a-f]+)"/.exec(svg)?.[1];
    const tile = body(machineFigureSvg(request({ frame: "tile" })));
    expect(tile).toBeDefined();
    expect(body(machineFigureSvg(request({ frame: "tile", state: { ...idle, install: "needs-update", missingHarness: true } })))).toBe(tile);
  });

  it("is a solid: a turn changes the faces that show", () => {
    const front = machineFigureSvg(request({ form: "server" }));
    const back = machineFigureSvg(request({ form: "server", turn: 180 }));
    expect(back).not.toBe(front);
    // The rack's vents are on its front face only.
    expect(back.length).toBeLessThan(front.length);
  });

  it("fills in installer steps and never animates", () => {
    const at = (step: number): number =>
      Number(/<clipPath id="p"><rect x="-20" y="([\d.-]+)"/.exec(machineFigureSvg(request({ state: { ...idle, install: "sending", step } })))?.[1]);
    expect(at(1)).toBeGreaterThan(at(3));
    expect(at(3)).toBeGreaterThan(at(5));
    expect(machineFigureSvg(request({ state: { ...idle, install: "sending", step: 3 } }))).not.toMatch(/<animate|@keyframes/);
  });

  it("stands the crew on the roof at the large size only", () => {
    const crew = [{ seed: "pip" }, { seed: "junto-1" }];
    const state = { ...idle, seats: 2 };
    expect(machineFigureSvg(request({ state, crew })).match(/<svg /g)?.length).toBe(3);
    expect(machineFigureSvg(request({ state, crew, detail: "card" })).match(/<svg /g)?.length).toBe(1);
  });

  it("picks the tier by size and the form from what the list knows", () => {
    expect([16, 28, 40, 96].map(machineDetailFor)).toEqual(["glyph", "glyph", "card", "rich"]);
    expect(resolveMachineForm({ name: "mac-mini", isThisMachine: false })).toBe("mac-mini");
    expect(resolveMachineForm({ name: "guilhermes-macbook-pro-2", isThisMachine: true })).toBe("macbook");
    expect(resolveMachineForm({ name: "boat-01", isThisMachine: false })).toBe("server");
    expect(resolveMachineForm({ name: "atlas", isThisMachine: false, glyph: "linux-box" })).toBe("linux-box");
    expect(resolveMachineForm({ name: "atlas", isThisMachine: false })).toBe("server");
    expect(resolveMachineForm({ name: "atlas", isThisMachine: true })).toBe("macbook");
    // Once a machine has reported, its name only chooses within that report.
    expect(resolveMachineForm({ name: "mac-mini", isThisMachine: false, reported: "linux" })).toBe("server");
    expect(resolveMachineForm({ name: "old-tower", isThisMachine: false, reported: "linux" })).toBe("linux-box");
    expect(resolveMachineForm({ name: "boat-01", isThisMachine: false, reported: "mac" })).toBe("mac-mini");
    expect(resolveMachineForm({ name: "my-macbook", isThisMachine: false, reported: "mac-studio" })).toBe("mac-studio");
    expect(resolveMachineForm({ name: "boat-01", isThisMachine: false, reported: "linux", glyph: "macbook" })).toBe("macbook");
  });
});
