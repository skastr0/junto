import { MACHINE_FORMS, type MachineForm } from "./draw";

/** The form a machine works out about itself and reports on its status. */
export type ReportedMachineForm = "macbook" | "mac-mini" | "mac-studio" | "mac" | "linux";

/** What the machine list knows about a machine that can pick its form. */
export interface MachineFormFacts {
  readonly name: string;
  readonly label?: string;
  readonly isThisMachine: boolean;
  /** The operator's choice, `appearance.glyph` on the machine row. */
  readonly glyph?: string;
  /** What the machine reported, once a status has been read. */
  readonly reported?: ReportedMachineForm;
}

// Names the machine list stored before forms existed.
const STORED: Readonly<Record<string, MachineForm>> = {
  "macbook-pro": "macbook",
  "terminal-dock": "macbook",
  laptop: "macbook",
  "compute-tower": "linux-box",
  cpu: "linux-box",
  "remote-anchor": "server",
  server: "server",
};

const FORMS = new Set<string>(MACHINE_FORMS);

function named(said: string): MachineForm | undefined {
  if (/\bmac[\s._-]*studio\b/.test(said)) return "mac-studio";
  if (/\bmac[\s._-]*mini\b|\bmini\b/.test(said)) return "mac-mini";
  if (/\bmacbook|\bmbp\b|\blaptop\b/.test(said)) return "macbook";
  if (/\b(vps|server|srv|cloud|boat|node)\b|\b(vps|srv|boat|node)[-_.]?\d/.test(said)) return "server";
  if (/\b(linux|box|tower|nuc|desktop|pc)\b/.test(said)) return "linux-box";
  return undefined;
}

const MAC_FORMS: ReadonlyArray<MachineForm> = ["macbook", "mac-mini", "mac-studio"];
const LINUX_FORMS: ReadonlyArray<MachineForm> = ["server", "linux-box"];

/**
 * The form a machine is drawn in. The operator's choice wins, then what the
 * machine reported about itself. The name only chooses within what was
 * reported (which Mac, a box or a server); it picks alone only while nothing
 * has been reported, and then a machine that says nothing is a laptop when it
 * is this one and a server otherwise.
 */
export function resolveMachineForm(facts: MachineFormFacts): MachineForm {
  if (facts.glyph && FORMS.has(facts.glyph)) return facts.glyph as MachineForm;
  const guess = named(`${facts.name} ${facts.label ?? ""}`.toLowerCase()) ?? (facts.glyph ? STORED[facts.glyph] : undefined);
  switch (facts.reported) {
    case "macbook":
    case "mac-mini":
    case "mac-studio":
      return facts.reported;
    case "mac":
      return guess && MAC_FORMS.includes(guess) ? guess : "mac-mini";
    case "linux":
      return guess && LINUX_FORMS.includes(guess) ? guess : "server";
    case undefined:
      return guess ?? (facts.isThisMachine ? "macbook" : "server");
  }
}
