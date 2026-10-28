/**
 * The owner's `machine.code-allow|deny|show` (docs/security-doctrine.md, Code
 * steps, check 4), answered by this machine's core: the allowance rows are
 * written here and nowhere else, never from a link and never from a seat (the
 * CLI refuses one before it calls).
 *
 * The canvas must be one this machine holds, and each trusted ruler a machine
 * this one knows, by short name or installation id; a typo is refused with
 * the nearest names, so an allowance never trusts nothing or the wrong
 * machine. With no ruler named, the list is the canvas's ruling installation
 * as this machine holds it (today its editing machine).
 */
import { Effect } from "effect";
import type { InstallationId } from "@shared/installation-id";
import {
  DEFAULT_CODE_ALLOWANCE_SCOPE,
  type MachineCodeAllowance,
  type MachineCodeAllowed,
  type MachineCodeAllowInput,
  type MachineCodeCanvasInput,
  type MachineCodeShowInput,
  type MachineCodeShown,
} from "@shared/machine-code";
import { RemoteHostsError } from "@shared/remote-hosts";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { nearestOf } from "../work/authz";
import { machineInstallations } from "../work/canvas-placement";
import { CodeAllowanceRepository, type CodeAllowance } from "./code-allowance";

const nearestWords = (nearest: ReadonlyArray<string>): string =>
  nearest.length === 0 ? "" : `; nearest: ${nearest.join(", ")}`;

export const makeCodeAllowanceOwner = Effect.gen(function* () {
  const allowances = yield* CodeAllowanceRepository;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const known = machineInstallations.pipe(Effect.provideService(MachineRepository, machines));

  const heldCanvas = (canvas: string) => Effect.gen(function* () {
    const held: ReadonlyArray<string> = yield* records.listCanvases();
    if (held.includes(canvas)) return canvas;
    return yield* Effect.fail(new RemoteHostsError("not_found", `This machine holds no canvas named ${canvas}${nearestWords(nearestOf(canvas, held))}`));
  });

  /** Each name or id to the installation this machine knows it as, or a refusal naming the nearest. */
  const rulersOf = (canvas: string, typed: ReadonlyArray<string> | undefined) => Effect.gen(function* () {
    if (typed === undefined) {
      const editor = (yield* records.canvasEditor(canvas)) ?? (yield* machines.installationId);
      return [editor as string];
    }
    const byName = yield* known;
    const ids = new Set<string>(byName.values());
    const out: string[] = [];
    for (const name of typed) {
      const id = byName.get(name) ?? (ids.has(name) ? name : undefined);
      if (id === undefined) {
        return yield* Effect.fail(new RemoteHostsError(
          "not_found",
          `This machine knows no machine named ${name}${nearestWords(nearestOf(name, [...byName.keys()]))}; junto machine list names them`,
        ));
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  });

  const viewOf = (canvas: string, allowance: CodeAllowance) => Effect.gen(function* () {
    const byName = yield* known;
    const nameOf = new Map([...byName].map(([name, id]) => [id as string, name]));
    return {
      canvas,
      scope: allowance.scope,
      rulers: allowance.installations.map((id) => {
        const machineName = nameOf.get(id);
        return { installationId: id as InstallationId, ...(machineName === undefined ? {} : { machineName }) };
      }),
    } satisfies MachineCodeAllowance;
  });

  const answer = (canvas: string) => Effect.gen(function* () {
    const allowance = yield* allowances.read(canvas);
    return { canvas, allowance: allowance === undefined ? null : yield* viewOf(canvas, allowance) } satisfies MachineCodeAllowed;
  });

  const allow = (input: MachineCodeAllowInput) => Effect.gen(function* () {
    const canvas = yield* heldCanvas(input.canvas);
    const installations = yield* rulersOf(canvas, input.rulers);
    yield* allowances.write(canvas, { scope: input.scope ?? DEFAULT_CODE_ALLOWANCE_SCOPE, installations });
    return yield* answer(canvas);
  });

  const deny = (input: MachineCodeCanvasInput) => Effect.gen(function* () {
    // A canvas this machine no longer holds has no allowance left to withdraw; deny still answers.
    yield* allowances.write(input.canvas, undefined);
    return yield* answer(input.canvas);
  });

  const show = (input: MachineCodeShowInput) => Effect.gen(function* () {
    if (input.canvas !== undefined) {
      const one = yield* answer(yield* heldCanvas(input.canvas));
      return { allowances: one.allowance === null ? [] : [one.allowance] } satisfies MachineCodeShown;
    }
    const all = yield* allowances.list();
    return { allowances: yield* Effect.forEach([...all], ([canvas, allowance]) => viewOf(canvas, allowance)) } satisfies MachineCodeShown;
  });

  return { allow, deny, show };
});

export type CodeAllowanceOwner = Effect.Success<typeof makeCodeAllowanceOwner>;
