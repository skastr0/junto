/**
 * A test file that patches a shared prototype or a global and does not put it
 * back poisons the files after it in the no-isolate shared lane (72e1c0e06:
 * quick-open-palette.test.tsx left HTMLElement.prototype.getClientRects
 * patched, and a later file failed). This guard records the own property
 * descriptors of the prototypes tests commonly patch, and of globalThis,
 * before each file. After the file it compares: any difference fails that
 * file with the property and the file named, and the original is put back so
 * the next file runs clean.
 *
 * Active only in the no-isolate shared lane (JUNTO_GUARD_SHARED_GLOBALS).
 *
 * A test that means to change a global for its own file restores it in an
 * afterEach/afterAll (vi.restoreAllMocks, vi.unstubAllGlobals, or by hand).
 * A new name nothing up the chain defines (a polyfill), or one that only
 * repeats the inherited value, is removed without failing the file.
 */
import { relative } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";

type Descriptors = Map<PropertyKey, PropertyDescriptor>;
type Target = { readonly label: string; readonly object: object };

/**
 * Bookkeeping a runtime or a library puts on globalThis by itself (vitest,
 * effect's current fiber), never a test's patch; deleting it would break them.
 * Symbol keys on globalThis are the same kind (undici's global dispatcher).
 */
const IGNORED_GLOBALS = /^(__vitest|__VITEST|__vite_ssr|__coverage__|~effect\/)/u;

const targets = (): readonly Target[] => {
  const g = globalThis as Record<string, unknown>;
  const proto = (name: string): object | undefined => {
    const ctor = g[name] as { readonly prototype?: object } | undefined;
    return typeof ctor === "function" ? ctor.prototype : undefined;
  };
  const found: Target[] = [];
  for (const name of [
    "EventTarget",
    "Node",
    "Element",
    "HTMLElement",
    "SVGElement",
    "HTMLCanvasElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLImageElement",
    "Document",
    "Range",
    "Selection",
  ]) {
    const object = proto(name);
    if (object !== undefined) found.push({ label: `${name}.prototype`, object });
  }
  const win = g.window as object | undefined;
  const winProto = win === undefined ? undefined : Object.getPrototypeOf(win);
  if (winProto !== null && winProto !== undefined && winProto !== Object.prototype) {
    found.push({ label: "Window.prototype", object: winProto as object });
  }
  found.push({ label: "globalThis", object: globalThis });
  return found;
};

const keysOf = (target: Target): readonly PropertyKey[] =>
  Reflect.ownKeys(target.object).filter(
    (key) =>
      !(
        target.label === "globalThis" &&
        (typeof key === "symbol" || IGNORED_GLOBALS.test(key))
      ),
  );

const record = (target: Target): Descriptors => {
  const out: Descriptors = new Map();
  for (const key of keysOf(target)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target.object, key);
    if (descriptor !== undefined) out.set(key, descriptor);
  }
  return out;
};

const same = (a: PropertyDescriptor, b: PropertyDescriptor): boolean =>
  Object.is(a.value, b.value) &&
  a.get === b.get &&
  a.set === b.set &&
  a.writable === b.writable &&
  a.enumerable === b.enumerable &&
  a.configurable === b.configurable;

const name = (key: PropertyKey): string => (typeof key === "symbol" ? key.toString() : String(key));

let before: ReadonlyArray<readonly [Target, Descriptors]> = [];

// On only where files share one environment: the lane runner sets this for
// the no-isolate shared lane (scripts/run-unit-tests.ts). An isolated fork
// reaches no other file, and a targeted `vitest run` leaves it unset.
const ACTIVE = process.env.JUNTO_GUARD_SHARED_GLOBALS === "1";

if (ACTIVE) beforeAll(() => {
  before = targets().map((target) => [target, record(target)] as const);
});

if (ACTIVE) afterAll(() => {
  const path = expect.getState().testPath;
  const file = path === undefined ? "this file" : relative(process.cwd(), path);
  const leaks: string[] = [];
  for (const [target, original] of before) {
    const now = new Set<PropertyKey>(keysOf(target));
    for (const [key, descriptor] of original) {
      const current = now.has(key) ? Reflect.getOwnPropertyDescriptor(target.object, key) : undefined;
      if (current !== undefined && same(descriptor, current)) continue;
      leaks.push(`${target.label}.${name(key)} was ${current === undefined ? "removed" : "changed"}`);
      try {
        Object.defineProperty(target.object, key, descriptor);
      } catch {
        // A non-configurable property cannot be put back; the message still names it.
      }
    }
    for (const key of now) {
      if (original.has(key)) continue;
      // A name nothing up the prototype chain defines is a polyfill of an API
      // the DOM lacks (ResizeObserver, scrollIntoView), and an own copy of the
      // inherited value is a "restore" that wrote the property back onto the
      // wrong object. Neither changes what a later file sees but its own
      // baseline, so both are removed quietly. A name that shadows an
      // inherited one with another value is the patch that poisons later files
      // (getClientRects on HTMLElement.prototype): it fails the file.
      const above = Object.getPrototypeOf(target.object) as object | null;
      const added = Reflect.getOwnPropertyDescriptor(target.object, key);
      const inherited = above === null ? undefined : Reflect.has(above, key);
      const harmless =
        inherited !== true ||
        (added !== undefined && "value" in added && Object.is(added.value, Reflect.get(above as object, key)));
      if (harmless) {
        try {
          Reflect.deleteProperty(target.object, key);
        } catch {
          // Not removable; harmless anyway.
        }
        continue;
      }
      leaks.push(`${target.label}.${name(key)} was added`);
      try {
        Reflect.deleteProperty(target.object, key);
      } catch {
        // Same: named, not restorable.
      }
    }
  }
  before = [];
  if (leaks.length > 0) {
    throw new Error(
      `${file} left shared state changed and did not restore it (put back so later files run clean): ${leaks.join("; ")}`,
    );
  }
});
