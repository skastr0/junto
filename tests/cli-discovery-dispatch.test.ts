/**
 * Every place a seat learns commands from names only commands this CLI
 * dispatches, and discovery names every command it dispatches. The tree is
 * the Effect command tree the entrypoint runs; the surfaces are discovery
 * (capabilities, schema, examples), help text, onboarding, the doctrine, the
 * docs topics and the overseer skill. Runs in whichever feature profile the
 * suite was started in, so each build is checked against itself.
 */
import { describe, expect, it } from "vitest";
import type { Command } from "effect/unstable/cli";
import { loadRootCommand } from "../src/cli/command-runner";
import { allExamples, allSchemas, commandCapabilities } from "../src/cli/core/discovery";
import { COMMAND_FAMILIES, ONBOARD_GUIDANCE } from "../src/shared/seat-onboarding";
import {
  NODE_DOCS,
  buildConceptsDoc,
  buildDoctrineDoc,
  buildNodeKindDoc,
  buildNodesCatalogDoc,
} from "../src/shared/junto-docs";
import { OVERSEER_SKILL_MARKDOWN } from "../src/cli/commands/overseer-skill";

type Node = { readonly name: string; readonly description: string | undefined; readonly subs: ReadonlyMap<string, Node> };

const toNode = (command: Command.Command.Any): Node => ({
  name: command.name,
  description: command.description,
  subs: new Map(command.subcommands.flatMap((group) => group.commands).map((sub) => [sub.name, toNode(sub)])),
});

const root = toNode(await loadRootCommand([]));

const paths = (node: Node, prefix: ReadonlyArray<string> = []): ReadonlyArray<{ path: string; node: Node }> =>
  [...node.subs.values()].flatMap((sub) => {
    const path = [...prefix, sub.name];
    return [{ path: path.join(" "), node: sub }, ...paths(sub, path)];
  });

const dispatched = paths(root);
const dispatchedPaths = new Set(dispatched.map((entry) => entry.path));
const leaves = dispatched.filter((entry) => entry.node.subs.size === 0).map((entry) => entry.path);

/** A discovery row's command, without the flags and placeholders some rows show. */
const commandWords = (command: string): string =>
  command.split(" ").filter((word, index, words) =>
    words.slice(0, index + 1).every((w) => /^[a-z][a-z0-9-]*$/.test(w))).join(" ");

/** Discovery rows that name a work op a seat never types, as their description says. */
const WORK_OPS = new Set(["content.stage"]);

/**
 * Dispatched families discovery leaves out on purpose: `machine` is the
 * operator's (refused to a seat before parsing), and `docs` is the reference
 * itself, which the onboard guidance points at.
 */
const UNDISCOVERED_FAMILIES = ["machine", "docs"];

const discoveryRows = [...commandCapabilities, ...allSchemas, ...allExamples]
  .filter((row) => !WORK_OPS.has(row.command_id));

describe("discovery and dispatch name the same commands", () => {
  it("every command discovery names is dispatched", () => {
    const missing = [...new Set(discoveryRows.map((row) => commandWords(row.command)))]
      .filter((command) => !dispatchedPaths.has(command));
    expect(missing).toEqual([]);
  });

  it("every example's argv runs a dispatched command", () => {
    const refused = allExamples.filter((example) => example.args !== undefined && !WORK_OPS.has(example.command_id))
      .filter((example) => !resolves(example.args!))
      .map((example) => example.args!.join(" "));
    expect(refused).toEqual([]);
  });

  it("every dispatched command is named by discovery, itself or through its group", () => {
    const named = new Set(discoveryRows.map((row) => commandWords(row.command)));
    const covered = (path: string): boolean => {
      const words = path.split(" ");
      return words.some((_, index) => named.has(words.slice(0, index + 1).join(" ")));
    };
    const unnamed = leaves.filter((path) =>
      !covered(path) && !UNDISCOVERED_FAMILIES.includes(path.split(" ")[0]!));
    expect(unnamed).toEqual([]);
  });
});

// ── The text a seat reads ──────────────────────────────────────────────────

/**
 * Where a command in text leads: walk the tree word by word until the words
 * stop or a leaf takes the rest as arguments. A group whose next word is not
 * one of its commands is a command the CLI would refuse.
 */
const resolves = (words: ReadonlyArray<string>, from: Node = root): boolean => {
  let node = from;
  for (const word of words) {
    if (!/^[a-z][a-z0-9|-]*$/.test(word)) return true;
    if (node.subs.size === 0) return true;
    const alternatives = word.split("|");
    if (!alternatives.every((alternative) => node.subs.has(alternative))) return false;
    if (alternatives.length > 1) return alternatives.every((alternative) => node.subs.get(alternative)!.subs.size === 0);
    node = node.subs.get(word)!;
  }
  return true;
};

/**
 * The commands a text names: every `junto <family> ...` run, and every code
 * span that opens with a family of `from` and a second word (`task rules`).
 * A lone word in a span is a kind or a field, not a command, and `junto`
 * before a word that is no family is prose ("its junto commands").
 */
const namedCommands = (text: string, from: Node = root): ReadonlyArray<string> => {
  const found: string[] = [];
  for (const match of text.matchAll(/\bjunto ((?:[a-z][a-z0-9|-]*)(?: [a-z][a-z0-9|-]*)*)/g)) {
    if (root.subs.has(match[1]!.split(" ")[0]!)) found.push(`junto ${match[1]!}`);
  }
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const words = match[1]!.split(/\s+/);
    if (words[0] === "junto") continue;
    if (words.length > 1 && from.subs.has(words[0]!)) found.push(words.join(" "));
  }
  return found;
};

/** A `junto ...` run resolves from the root; a bare span from `from`, or from the root (`overseer status`). */
const resolvesNamed = (command: string, from: Node = root): boolean => {
  const words = command.split(" ");
  if (words[0] === "junto") return resolves(words.slice(1));
  return resolves(words, from) || (from !== root && resolves(words));
};

const overseer = root.subs.get("overseer")!;

const helpOf = (family: (path: string) => boolean): string =>
  dispatched.filter((entry) => family(entry.path)).map((entry) => entry.node.description ?? "").join("\n");

const onboardingText = [
  ...ONBOARD_GUIDANCE,
  ...Object.values(COMMAND_FAMILIES).flatMap((family) => [
    family.note,
    ...family.rows.flatMap((row) => [`\`${row.command("<target>")}\``, row.detail ?? ""]),
  ]),
].join("\n");

const nodeDocsText = NODE_DOCS.map((doc) => buildNodeKindDoc(doc.kind) ?? "").join("\n");

/** What a plain seat reads. The doctrine carries the worked examples this build renders. */
const SEAT_SURFACES: Readonly<Record<string, string>> = {
  onboarding: onboardingText,
  "docs doctrine": buildDoctrineDoc(),
  "docs concepts": buildConceptsDoc(),
  "docs nodes": buildNodesCatalogDoc(),
  "docs node": nodeDocsText,
  help: helpOf((path) => !path.startsWith("overseer")),
};

describe("the text a seat learns commands from", () => {
  it.each(Object.keys(SEAT_SURFACES))("%s names only dispatched commands", (surface) => {
    const refused = namedCommands(SEAT_SURFACES[surface]!).filter((command) => !resolvesNamed(command));
    expect([...new Set(refused)]).toEqual([]);
  });

  const OVERSEER_SURFACES: Readonly<Record<string, string>> = {
    "overseer skill": OVERSEER_SKILL_MARKDOWN,
    "overseer help": helpOf((path) => path.startsWith("overseer")),
  };

  // The overseer skill names its verbs bare (`node create`), relative to `junto overseer`.
  it.each(Object.keys(OVERSEER_SURFACES))("%s names only dispatched commands", (surface) => {
    const refused = namedCommands(OVERSEER_SURFACES[surface]!, overseer).filter((command) => !resolvesNamed(command, overseer));
    expect([...new Set(refused)]).toEqual([]);
  });

  /** Commands and ops the 0.10 deletions removed from every surface, and the waiver a finish no longer takes. */
  const DELETED: ReadonlyArray<RegExp> = [
    /\bjunto (?:pad|sheet|tasks)\b/,
    /\bartifact[ .]publish\b/,
    /\bscheduler[ .](?:fire|status|configure)\b/,
    /\brelay\.trigger\b/,
    // The command; the port stays on reviews wires until canvas rewrites them.
    /\b(?:junto )?verdict post\b/,
    /--waive\b/,
    /\bwaivers?\b/i,
  ];

  /**
   * Deleted for a plain seat, still dispatched for an overseer until the old
   * task store and the reviews edge go: overseer task claim, update and
   * promote, and overseer automation writes.
   */
  const DELETED_FOR_SEATS: ReadonlyArray<RegExp> = [
    /(?<!overseer )\btask (?:claim|update|promote|verdict)\b/,
    /(?<!overseer )\bautomation (?:create|edit|enable|disable|archive|run)\b/,
  ];

  const deletedIn = (text: string, patterns: ReadonlyArray<RegExp>) =>
    patterns.flatMap((pattern) => text.match(pattern) ?? []);

  it.each(Object.keys(SEAT_SURFACES))("%s names no deleted command or op", (surface) => {
    expect(deletedIn(SEAT_SURFACES[surface]!, [...DELETED, ...DELETED_FOR_SEATS])).toEqual([]);
  });

  it.each(Object.keys(OVERSEER_SURFACES))("%s names no deleted command or op", (surface) => {
    expect(deletedIn(OVERSEER_SURFACES[surface]!, DELETED)).toEqual([]);
  });

  it("the resolver refuses a group's unknown command and passes a leaf's arguments", () => {
    expect(resolves(["msg", "send", "--prompt"])).toBe(true);
    expect(resolves(["msg", "publish"])).toBe(false);
    expect(resolves(["no-such-family"])).toBe(false);
    expect(resolves(["node", "create"], overseer)).toBe(true);
    expect(namedCommands("run `junto msg publish` then `msg send`; its junto commands")).toEqual(["junto msg publish", "msg send"]);
    expect(resolvesNamed("junto msg publish")).toBe(false);
  });
});
