/**
 * Two-witness oracle for T0 QA.
 *
 * Witness 1 is the running app's own projection: the compiled canvas read
 * through the owner-local canvas control socket, and the deterministic
 * `digestCanvas` text built from it (the exact path `bun run digest` takes).
 * Witness 2 is the screen: the rendered DOM text. A disagreement between the
 * two is a "state right, UI wrong" finding. No model is involved.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import type { CanvasDoc, CanvasNode } from "../../src/shared/canvas";
import type { Sandbox } from "../harness/sandbox";

const run = promisify(execFile);
const WITNESS = join(process.cwd(), "e2e/qa/witness.ts");

export interface AppWitness {
  readonly doc: CanvasDoc;
  readonly digest: string;
  /** sha256 of the canonical document (nodes + edges), independent of live snapshots. */
  readonly docHash: string;
  /** node id -> digest entity title, for every entity node. */
  readonly titles: ReadonlyMap<string, string>;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

/**
 * Entity lines in the digest are `<title> :: <kind>`, one per entity node, in
 * document order. Zip them back onto the document's entity nodes.
 */
const entityTitles = (doc: CanvasDoc, digest: string): Map<string, string> => {
  const lines = digest.split("\n");
  const start = lines.indexOf("entities");
  const titles = new Map<string, string>();
  if (start < 0) return titles;
  const entityNodes = doc.nodes.filter((node) => node.ether?.entity !== undefined);
  let index = 0;
  for (const line of lines.slice(start + 1)) {
    if (line === "" || index >= entityNodes.length) break;
    if (line.startsWith(" ")) continue;
    const match = /^(.*) :: ([\w-]+)$/.exec(line);
    if (!match) break;
    const node = entityNodes[index]!;
    titles.set(node.id, match[1]!);
    index += 1;
  }
  return titles;
};

/**
 * Read the app's projection of one canvas through its control socket. The
 * helper runs under bun (see witness.ts) and is pinned to the sandbox's
 * control directory, so it can never reach an operator's live app.
 */
export const readAppWitness = (sandbox: Sandbox, canvas: string): Promise<AppWitness> =>
  readWitnessAt(sandbox.homeDir, canvas);

const witnessCall = async (home: string, arg: string): Promise<string> => {
  const { stdout } = await run(process.env.BUN_BIN ?? "bun", [WITNESS, arg], {
    env: {
      ...process.env,
      HOME: home,
      JUNTO_HOME: home,
      JUNTO_CANVAS_CONTROL_HOME: join(home, ".junto", "canvas"),
    },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
  });
  return stdout;
};

/** Canvas names the app under `home` reports through its control socket. */
export const listCanvasesAt = async (home: string): Promise<string[]> =>
  (JSON.parse(await witnessCall(home, "--list")) as Array<{ readonly name: string }>).map((entry) => entry.name);

/** Same projection as readAppWitness, for an app started with HOME=`home` (the packaged tiers). */
export const readWitnessAt = async (home: string, canvas: string): Promise<AppWitness> => {
  const read = JSON.parse(await witnessCall(home, canvas)) as { readonly doc: CanvasDoc; readonly digest: string };
  const docHash = createHash("sha256")
    .update(canonical({ nodes: read.doc.nodes, edges: read.doc.edges }))
    .digest("hex");
  return { doc: read.doc, digest: read.digest, docHash, titles: entityTitles(read.doc, read.digest) };
};

// --- screen witness ------------------------------------------------------------

export interface RenderedNode {
  readonly id: string;
  readonly text: string;
}

export const readRenderedNodes = (page: Page): Promise<RenderedNode[]> =>
  page.locator(".react-flow__node[data-id]").evaluateAll((els) =>
    els.map((el) => ({ id: el.getAttribute("data-id") ?? "", text: el.textContent ?? "" })),
  );

export const normalizeText = (text: string): string =>
  text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

/** A link card may render only the host; the document holds the full URL. */
export const titleCandidates = (node: CanvasNode | undefined, title: string): string[] => {
  const out = [title];
  if (node?.type === "link") {
    try {
      const url = new URL(title);
      out.push(url.host, url.host.replace(/^www\./, ""));
    } catch {
      // not a URL; the title stands alone
    }
  }
  return out.map(normalizeText);
};

// --- invariant checks ----------------------------------------------------------

/** A single violated invariant; `detail` is the raw evidence, `signature` feeds the fingerprint. */
export interface Violation {
  readonly invariant: string;
  readonly signature: string;
  readonly detail: string;
}

/** render-parity: the canvas renders exactly the document's nodes. */
export const checkRenderParity = (witness: AppWitness, rendered: ReadonlyArray<RenderedNode>): Violation[] => {
  const docIds = new Set(witness.doc.nodes.map((node) => node.id));
  const screenIds = new Set(rendered.map((node) => node.id));
  const out: Violation[] = [];
  for (const id of docIds) {
    if (!screenIds.has(id)) {
      out.push({ invariant: "render-parity", signature: `missing on screen: ${id}`, detail: `document node ${id} is not rendered` });
    }
  }
  for (const id of screenIds) {
    if (!docIds.has(id)) {
      out.push({ invariant: "render-parity", signature: `extra on screen: ${id}`, detail: `rendered node ${id} is not in the document` });
    }
  }
  return out;
};

/** label-parity: every rendered entity card shows the digest's title for it. */
export const checkLabelParity = (witness: AppWitness, rendered: ReadonlyArray<RenderedNode>): Violation[] => {
  const byId = new Map(witness.doc.nodes.map((node) => [node.id, node] as const));
  const out: Violation[] = [];
  for (const card of rendered) {
    const title = witness.titles.get(card.id);
    if (title === undefined || title.trim() === "") continue;
    const text = normalizeText(card.text);
    const candidates = titleCandidates(byId.get(card.id), title);
    if (!candidates.some((candidate) => text.includes(candidate))) {
      out.push({
        invariant: "label-parity",
        signature: `${card.id} card lacks digest title`,
        detail: `digest title "${title}" not in rendered card text "${card.text.replace(/\s+/g, " ").trim().slice(0, 160)}"`,
      });
    }
  }
  return out;
};

const LEAKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\u00b7/, "middle dot"],
  [/\bundefined\b/, "undefined"],
  [/\bNaN\b/, "NaN"],
  [/\[object Object\]/, "[object Object]"],
];

/** copy-law: visible text carries no middle dot and no leaked JS value. */
export const checkCopyLaw = async (page: Page, scope: string): Promise<Violation[]> => {
  const text = await page.evaluate(() => document.body.innerText);
  const out: Violation[] = [];
  for (const [pattern, name] of LEAKS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const at = match.index;
    const excerpt = text.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ");
    out.push({ invariant: "copy-law", signature: `${scope}: ${name}`, detail: `"${excerpt}"` });
  }
  return out;
};
