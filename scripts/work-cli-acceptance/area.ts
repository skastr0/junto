/**
 * One area of the 0.10 CLI acceptance net (scripts/work-cli-acceptance.ts).
 * Each area is a file in this directory, owned by one seat, so two seats
 * never edit the same lines; the main script runs them in `AREAS` order
 * (index.ts) against one real core and one sandboxed canvas.
 *
 * An area answers with cases. A case is a pass, a fail, or pending: a verb
 * not yet on main names the cli seat building it, and is never a skip.
 */
import type { ManagedRuntime } from "effect";
import type { WorkCliCommandResult } from "../work-cli-acceptance";

export type CaseVerdict =
  | { readonly area: string; readonly name: string; readonly status: "pass" }
  | { readonly area: string; readonly name: string; readonly status: "fail"; readonly detail: string }
  /** The verb is not on main yet; `on` is the cli seat building it. */
  | { readonly area: string; readonly name: string; readonly status: "pending"; readonly on: string };

/** A seat on the acceptance canvas the CLI can run as. */
export type AcceptanceSeat = { readonly nodeId: string; readonly agentKey: string };

export type AcceptanceContext = {
  readonly canvas: string;
  /**
   * The seeded nodes every area may use. `region` holds them all; `elsewhere`
   * is a region on no line with it, for a seat out of their reach.
   */
  readonly nodes: {
    readonly agent: string;
    readonly tasks: string;
    readonly requests: string;
    readonly artifacts: string;
    readonly region: string;
    readonly elsewhere: string;
  };
  /**
   * The compiled CLI from a cwd outside the repo, as the seeded agent or
   * `as`, with `env` merged over the net's own for this one call.
   */
  readonly cli: (args: ReadonlyArray<string>, as?: AcceptanceSeat, env?: NodeJS.ProcessEnv) => Promise<WorkCliCommandResult>;
  /**
   * One raw work-socket request, as the seeded agent or `as`, past the CLI:
   * for an argument shape the CLI can no longer send. The parsed response.
   */
  readonly call: (op: string, args: unknown, as?: AcceptanceSeat) => Promise<any>;
  /**
   * A new agent seat on the canvas at (x, y), with a credential the CLI can
   * run as. Region (0,0 900x200) reaches the seeded nodes; elsewhere
   * (1200,0 600x200) reaches none of them. With `overseer`, the operator
   * then grants it overseer by GrantOverseer, as the canvas toggle does.
   */
  readonly addSeat: (
    nodeId: string,
    at: { readonly x: number; readonly y: number },
    options?: { readonly overseer?: boolean },
  ) => Promise<AcceptanceSeat>;
  /** The core's runtime, for reads an area checks the CLI against. */
  readonly runtime: ManagedRuntime.ManagedRuntime<never, never>;
  readonly log: (label: string, body: string) => void;
  /** A sandbox directory outside the repo for files an area writes. */
  readonly outside: string;
};

export type AcceptanceArea = {
  readonly name: string;
  /** The seat that owns this file. */
  readonly owner: string;
  readonly run: (context: AcceptanceContext) => Promise<ReadonlyArray<CaseVerdict>>;
};

/** A result's JSON body, or undefined when stdout is not one JSON value. */
export const bodyOf = (result: WorkCliCommandResult): any => {
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
};

/** Case helpers for one area. */
export const casesFor = (area: string) => ({
  pass: (name: string): CaseVerdict => ({ area, name, status: "pass" }),
  fail: (name: string, detail: string): CaseVerdict => ({ area, name, status: "fail", detail }),
  pending: (name: string, on: string): CaseVerdict => ({ area, name, status: "pending", on }),
  /** Pass when `ok`, else fail with the command's output as the detail. */
  check: (name: string, ok: boolean, result?: WorkCliCommandResult): CaseVerdict =>
    ok ? { area, name, status: "pass" } : { area, name, status: "fail", detail: result === undefined ? "" : (result.stdout || result.stderr).slice(0, 2_000) },
});
