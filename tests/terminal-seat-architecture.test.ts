import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Cement for occupy-only-when-vacant.
//
// Occupied seats activate; vacant seats occupy. Create must not replace a
// live binding. Types cannot stop an agent from inventing a create-as-replace
// branch, so these four surfaces are scanned for the occupancy consult and
// the retired reuse vocabulary.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const display = (path: string): string => relative(root, path);

const readSource = (relativePath: string): { path: string; source: string } => {
  const path = join(root, relativePath);
  return { path, source: readFileSync(path, "utf8") };
};

const LOCAL_HOST = "src/main/junto/term/local-host.ts";
const ROUTER = "src/main/junto/term/router.ts";
const CONTROL_SERVER = "src/main/junto/term/control-server.ts";
const TERMINAL_ACTIONS = "src/renderer/lib/terminal-actions.ts";

const OCCUPANCY =
  /\b(?:occupyVacantSeat|occupancyFromSession|occupancyFromSummary|SeatOccupancy)\b/u;
const SPAWN =
  /\bspawnTerminal\s*\(|\bthis\.open\s*\(|\bclient\.create\s*\(|\bhost\.create\s*\(|\bterminalCreate\s*\(/u;

const skipQuoted = (text: string, start: number): number => {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return text.length;
};

const matchingClose = (
  text: string,
  openIndex: number,
  open: "{" | "(",
  close: "}" | ")",
): number | undefined => {
  let depth = 0;
  let i = openIndex;
  while (i < text.length) {
    const ch = text[i]!;
    // Comments may hold apostrophes and unbalanced braces; skip them whole.
    if (ch === "/" && text[i + 1] === "/") {
      const eol = text.indexOf("\n", i);
      i = eol < 0 ? text.length : eol + 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipQuoted(text, i);
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return undefined;
};

const braceBody = (text: string, openBrace: number): string | undefined => {
  const close = matchingClose(text, openBrace, "{", "}");
  return close === undefined ? undefined : text.slice(openBrace, close + 1);
};

/** Class method / function whose header matches `header`, body brace-matched. */
const declarationBody = (source: string, header: RegExp): string | undefined => {
  const match = header.exec(source);
  if (!match) return undefined;
  const paren = source.indexOf("(", match.index);
  if (paren < 0) return undefined;
  const closeParen = matchingClose(source, paren, "(", ")");
  if (closeParen === undefined) return undefined;
  // Arrow functions put `{` in the return type before `=>`. Prefer the body.
  const afterParams = source.slice(closeParen, closeParen + 400);
  const arrowLocal = afterParams.indexOf("=>");
  const searchFrom = arrowLocal >= 0 ? closeParen + arrowLocal + 2 : closeParen;
  const openBrace = source.indexOf("{", searchFrom);
  if (openBrace < 0) return undefined;
  return braceBody(source, openBrace);
};

const methodHeader = (name: string): RegExp =>
  new RegExp(
    String.raw`^[ \t]+(?:(?:private|public|protected|async|static)\s+)*${name}\s*\(`,
    "mu",
  );

const caseBody = (source: string, op: string): string | undefined => {
  const match = new RegExp(
    String.raw`case\s+["']${op}["']\s*:\s*\{`,
    "u",
  ).exec(source);
  if (!match) return undefined;
  const openBrace = source.indexOf("{", match.index);
  if (openBrace < 0) return undefined;
  return braceBody(source, openBrace);
};

const consultsOccupancy = (body: string): boolean => OCCUPANCY.test(body);

const occupancyBeforeSpawn = (body: string): boolean => {
  const occupancyAt = body.search(OCCUPANCY);
  const spawnAt = body.search(SPAWN);
  if (occupancyAt < 0) return false;
  return spawnAt < 0 || occupancyAt < spawnAt;
};

describe("terminal seat architecture", () => {
  it("local create / createAgentSeat / open consult occupancy before spawn", () => {
    const { path, source } = readSource(LOCAL_HOST);
    const loc = display(path);
    const create = declarationBody(source, methodHeader("create"));
    const createAgentSeat = declarationBody(
      source,
      methodHeader("createAgentSeat"),
    );
    const open = declarationBody(source, methodHeader("open"));
    const violations: string[] = [];

    if (!create) {
      violations.push(`${loc} — create missing`);
    } else if (consultsOccupancy(create)) {
      if (!occupancyBeforeSpawn(create)) {
        violations.push(`${loc} — create occupancy is not before spawn`);
      }
    } else if (!/\bthis\.open\s*\(/.test(create) || /\bspawnTerminal\b/.test(create)) {
      // Geography create delegates to private open; open is the occupancy gate.
      violations.push(`${loc} — create exists but occupancy is not consulted`);
    }

    if (!createAgentSeat) {
      violations.push(`${loc} — createAgentSeat missing`);
    } else if (!consultsOccupancy(createAgentSeat)) {
      violations.push(
        `${loc} — createAgentSeat exists but occupancy is not consulted`,
      );
    } else if (!occupancyBeforeSpawn(createAgentSeat)) {
      violations.push(
        `${loc} — createAgentSeat occupancy is not before spawn`,
      );
    }

    if (!open) {
      violations.push(`${loc} — open missing`);
    } else if (!consultsOccupancy(open)) {
      violations.push(`${loc} — open exists but occupancy is not consulted`);
    } else if (!occupancyBeforeSpawn(open)) {
      violations.push(`${loc} — open occupancy is not before spawn`);
    }

    expect(violations).toEqual([]);
  });

  it("remote create consults occupancy and does not reuse a live generation", () => {
    const { path, source } = readSource(ROUTER);
    const loc = display(path);
    const createRemote = declarationBody(source, methodHeader("createRemote"));
    const violations: string[] = [];

    if (!createRemote) {
      violations.push(`${loc} — createRemote missing`);
    } else if (!consultsOccupancy(createRemote)) {
      violations.push(
        `${loc} — createRemote exists but occupancy is not consulted`,
      );
    } else if (!occupancyBeforeSpawn(createRemote)) {
      violations.push(`${loc} — createRemote occupancy is not before spawn`);
    }

    if (/\bliveAgentGenerationToReuse\b/.test(source)) {
      violations.push(`${loc} — liveAgentGenerationToReuse must not return`);
    }

    expect(violations).toEqual([]);
  });

  it("control-server splits geography create from actor occupation", () => {
    const { path, source } = readSource(CONTROL_SERVER);
    const loc = display(path);
    const create = caseBody(source, "create");
    const createAgentSeat = caseBody(source, "createAgentSeat");
    const violations: string[] = [];

    if (!create) {
      violations.push(`${loc} — case "create" missing`);
    } else {
      if (!/\bhost\.create\s*\(/u.test(create)) {
        violations.push(`${loc} — geography create does not delegate to host.create`);
      }
      if (/\bhost\.createAgentSeat\s*\(/u.test(create)) {
        violations.push(`${loc} — geography create can enter the actor path`);
      }
      if (!/does not accept harness or agentKey/u.test(create)) {
        violations.push(`${loc} — geography create does not reject actor fields`);
      }
    }

    if (!createAgentSeat) {
      violations.push(`${loc} — case "createAgentSeat" missing`);
    } else {
      const occupancyAt = createAgentSeat.search(OCCUPANCY);
      const spawnAt = createAgentSeat.search(/\bhost\.createAgentSeat\s*\(/u);
      if (occupancyAt < 0) {
        violations.push(`${loc} — actor occupation does not consult occupancy`);
      } else if (spawnAt < 0 || occupancyAt > spawnAt) {
        violations.push(`${loc} — actor occupancy is not before spawn`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("delegates actor WHEN to Main while geography still consults occupancy", () => {
    const { path, source } = readSource(TERMINAL_ACTIONS);
    const loc = display(path);
    const ensure = declarationBody(
      source,
      /^(?:export\s+)?const\s+ensureTerminalRunning\s*=/mu,
    );
    const violations: string[] = [];

    if (!ensure) {
      violations.push(`${loc} — ensureTerminalRunning missing`);
    } else {
      const actorStart = ensure.indexOf('if (entityKind === "agent") {');
      const geographyStart = ensure.indexOf(
        'if (entityKind !== "terminal") {',
        actorStart,
      );
      const actor =
        actorStart >= 0 && geographyStart > actorStart
          ? ensure.slice(actorStart, geographyStart)
          : undefined;
      const geography =
        geographyStart >= 0 ? ensure.slice(geographyStart) : undefined;

      if (!actor) {
        violations.push(`${loc} — exact agent arm missing`);
      } else {
        const createAt = actor.search(/\bterminalCreate\s*\(/u);
        const getAt = actor.search(/\bterminalGet\b/u);
        if (createAt < 0) {
          violations.push(`${loc} — agent arm does not delegate to terminalCreate`);
        } else if (getAt >= 0 && getAt < createAt) {
          violations.push(`${loc} — agent arm makes a renderer occupancy decision`);
        }
        if (consultsOccupancy(actor)) {
          violations.push(`${loc} — actor WHEN must stay in Main ActorSeatOccupy`);
        }
      }

      if (!geography) {
        violations.push(`${loc} — exact terminal geography arm missing`);
      } else if (!consultsOccupancy(geography)) {
        violations.push(`${loc} — geography occupancy is not consulted`);
      } else if (!occupancyBeforeSpawn(geography)) {
        violations.push(`${loc} — geography occupancy is not before create`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("does not resurrect create-as-replace", () => {
    const banned: ReadonlyArray<readonly [RegExp, string]> = [
      [
        /\bliveAgentGenerationToReuse\b/u,
        "live generation reuse is retired — occupy only when vacant",
      ],
      [
        /kills a live binding/u,
        "Remote create must not kill a live binding as product law",
      ],
    ];
    const files = [LOCAL_HOST, ROUTER, CONTROL_SERVER, TERMINAL_ACTIONS];
    const violations = files.flatMap((relativePath) => {
      const { path, source } = readSource(relativePath);
      return banned.flatMap(([pattern, why]) =>
        pattern.test(source) ? [`${display(path)} — ${why}`] : [],
      );
    });
    expect(violations).toEqual([]);
  });
});
