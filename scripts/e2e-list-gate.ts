#!/usr/bin/env bun
/**
 * The gate run-e2e.sh passes before any spec runs: Playwright's own list of
 * the tests (`playwright test --list --reporter=json`, on stdin) must load
 * every file, hold at least one test, and hold one for each spec file named.
 *
 * From 21504d42d to 61fdb4e84 one spec threw while loading, so the full suite
 * listed 0 of 478 tests and no receipt read that as red. A run now refuses
 * instead, and says how many tests it is about to run.
 *
 * usage: playwright test --list --reporter=json ... | bun scripts/e2e-list-gate.ts [args given to run-e2e.sh]
 */

type ListedSpec = { readonly file: string; readonly tests: readonly unknown[] };
type ListedSuite = {
  readonly file?: string;
  readonly specs?: readonly ListedSpec[];
  readonly suites?: readonly ListedSuite[];
};
type Listed = {
  readonly suites?: readonly ListedSuite[];
  readonly errors?: ReadonlyArray<{ readonly message?: string; readonly location?: { readonly file?: string } }>;
};

const fail = (message: string): never => {
  console.error(`junto: error: ${message}`);
  process.exit(1);
};

const raw = await Bun.stdin.text();
const start = raw.indexOf("{");
let listed: Listed;
try {
  listed = JSON.parse(start === -1 ? raw : raw.slice(start)) as Listed;
} catch {
  fail(`Playwright did not list the tests; its output was:\n${raw.slice(0, 2000)}`);
  throw new Error("unreachable");
}

for (const error of listed.errors ?? []) {
  const where = error.location?.file === undefined ? "" : ` (${error.location.file})`;
  console.error(`junto: a spec failed to load${where}: ${(error.message ?? "").split("\n")[0]}`);
}
if ((listed.errors ?? []).length > 0) fail(`${listed.errors!.length} load error(s): no test runs until every spec loads`);

// Tests per file, by the path Playwright gives relative to its test dir.
const perFile = new Map<string, number>();
const walk = (suite: ListedSuite): void => {
  for (const spec of suite.specs ?? []) perFile.set(spec.file, (perFile.get(spec.file) ?? 0) + spec.tests.length);
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of listed.suites ?? []) walk(suite);
const total = [...perFile.values()].reduce((sum, count) => sum + count, 0);
if (total === 0) fail("Playwright lists 0 tests: nothing would run");

// A named spec must list a test, unless a filter (--grep and the like) may
// leave it none on purpose.
const args = process.argv.slice(2);
const filtered = args.some((arg) => /^(-g|--grep|--grep-invert|--project|--shard|--last-failed|--only-changed)(=|$)/.test(arg));
if (!filtered) {
  const named = args.filter((arg) => /\.spec\.tsx?(:\d+)*$/.test(arg)).map((arg) => arg.replace(/(:\d+)+$/, ""));
  const empty = named.filter((spec) => ![...perFile].some(([file, count]) => count > 0 && spec.endsWith(file)));
  if (empty.length > 0) fail(`these specs list no test: ${empty.join(", ")}`);
}

console.error(`junto: e2e lists ${total} tests in ${perFile.size} files`);
