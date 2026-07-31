import { Context, Layer } from "effect";
import { PROVIDER_MARKS, type ProviderMarkData } from "./provider-marks.generated";
import { HERMES_AGENT_ICON } from "./official-agent-assets";
import { DIM, HUE, INK } from "./theme";

// The provider:agent:icon repository, in three layers:
//
//   data       — PROVIDER_MARKS (generated from the local CodexBar.app
//                provider-icon set; do not edit) plus CURATED, a small set
//                of hand-picked overrides whose marks beat the generated
//                ones (official source art the CodexBar set lacks).
//   facade     — GLYPHS (merged table, curated wins) + ALIASES, queried
//                through harnessGlyphFor / harnessDisplayName / harnessHue.
//   contract   — MarksService / Marks / MarksLive / marks: the Effect-shaped
//                IoC seam (see the comment at MarksService).
//
// Generated marks are monochrome: they carry hex "#000000" and harnessHue
// remaps near-black brands to house INK so they read on the dark field.
// Most generated marks are a single path; multi-path or non-24×24 source
// art carries its own `viewBox`/`fillRule` straight from the table.

export interface HarnessGlyph {
  readonly d?: string | ReadonlyArray<string>; // SVG path data, `viewBox` grid
  readonly imageSrc?: string; // exact raster asset when a vendor publishes no standalone vector
  readonly viewBox?: string; // defaults to "0 0 24 24"
  readonly fillRule?: "evenodd"; // defaults to nonzero; ring/hole marks need evenodd
  readonly hex: string; // brand hex ("#000000" for monochrome brands)
  readonly displayName: string;
}

// Curated overrides. These keep the better marks we already had — do NOT
// replace them with generated data: claude uses Anthropic's official
// monochrome mark, gemini carries brand color, openai
// is the Wikimedia symbol on its native 20×20 grid, and the CodexBar set
// skips kimi, windsurf, and hermes entirely. Everything else (including grok,
// codex, devin, amp — same source data) resolves from the generated table.
const CURATED: Readonly<Record<string, HarnessGlyph>> = {
  claude: {
    d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
    hex: "#000000",
    displayName: "Claude",
  },
  googlegemini: {
    d: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
    hex: "#8E75B2",
    displayName: "Gemini",
  },
  openai: {
    d: "M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z",
    viewBox: "0 0 20 20",
    hex: "#000000",
    displayName: "OpenAI",
  },
  kimi: {
    d: "M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441",
    hex: "#000000",
    displayName: "Kimi",
  },
  windsurf: {
    d: "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z",
    hex: "#0B100F",
    displayName: "Windsurf",
  },
  hermes: {
    // Exact official 48px app icon published by Nous Research.
    imageSrc: HERMES_AGENT_ICON,
    hex: "#000000",
    displayName: "Hermes",
  },
};

// Brand casing for generated ids where plain capitalization misreads the
// name. Anything not listed displays as its id with the first letter raised.
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  opencode: "OpenCode",
  opencodego: "OpenCode Go",
  crossmodel: "CrossModel",
  deepseek: "DeepSeek",
  elevenlabs: "ElevenLabs",
  jetbrains: "JetBrains",
  litellm: "LiteLLM",
  llmproxy: "LLM Proxy",
  minimax: "MiniMax",
  openrouter: "OpenRouter",
  stepfun: "StepFun",
  t3chat: "T3 Chat",
  vertexai: "Vertex AI",
  zai: "Z.AI",
};

const capitalize = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

// A generated mark is monochrome source data: consumers assign hue, so the
// glyph records the house "#000000" that harnessHue remaps to INK.
const fromProviderMark = (id: string, mark: ProviderMarkData): HarnessGlyph => ({
  d: mark.paths,
  viewBox: mark.viewBox,
  fillRule: mark.fillRule,
  hex: "#000000",
  displayName: DISPLAY_NAMES[id] ?? capitalize(id),
});

// The merged repository: every generated provider id, with curated overrides
// winning on key collision (claude).
export const GLYPHS: Readonly<Record<string, HarnessGlyph>> = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_MARKS).map(([id, mark]) => [id, fromProviderMark(id, mark)]),
  ),
  ...CURATED,
};

// Common spoken/CLI spellings → canonical GLYPHS key. Compared after
// trim + lowercase + whitespace collapse. Canonical provider ids (ollama,
// zed, antigravity, warp, deepseek, mistral, perplexity, opencodego, …)
// need no entry — they pass through to the generated table directly.
const ALIASES: Readonly<Record<string, string>> = {
  "claude code": "claude",
  "claude-code": "claude",
  gemini: "googlegemini",
  "gemini cli": "googlegemini",
  "github copilot": "copilot",
  chatgpt: "openai",
  "chat gpt": "openai",
  gpt: "openai",
  "open code": "opencode",
  "open code go": "opencodego",
  xai: "grok",
  ampcode: "amp",
  cognition: "devin",
  "hermes agent": "hermes",
  nous: "hermes",
  "nous research": "hermes",
};

// Monogram palette for harnesses with no brand glyph. Crimson deliberately
// excluded — it is reserved for blockers house-wide.
export const MONOGRAM_HUES: ReadonlyArray<string> = [
  HUE.amber,
  HUE.cyan,
  HUE.violet,
  HUE.gold,
  HUE.indigo,
  HUE.orange,
];

const normalize = (agent: string): string => agent.trim().toLowerCase().replace(/\s+/g, " ");

// FNV-1a 32-bit — stable across runs and platforms, so a given harness name
// always lands on the same monogram hue.
const fnv1a = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** Brand glyph for an agent string, alias-resolved; undefined when unknown. */
export function harnessGlyphFor(agent?: string): HarnessGlyph | undefined {
  if (!agent) return undefined;
  const key = normalize(agent);
  if (!key) return undefined;
  return GLYPHS[ALIASES[key] ?? key];
}

/** Glyph display name, else the raw agent capitalized, else "agent". */
export function harnessDisplayName(agent?: string): string {
  const glyph = harnessGlyphFor(agent);
  if (glyph) return glyph.displayName;
  const trimmed = agent?.trim() ?? "";
  if (!trimmed) return "agent";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Tile/monogram hue for an agent: the brand hex when the brand has real color;
 * near-black brands (#000000, #0B100F) remap to house INK so the mark reads on
 * the dark field; glyph-less agents get a deterministic palette hue.
 */
export function harnessHue(agent?: string): string {
  const glyph = harnessGlyphFor(agent);
  if (glyph) {
    return glyph.hex === "#000000" || glyph.hex === "#0B100F" ? INK : glyph.hex;
  }
  return MONOGRAM_HUES[fnv1a(normalize(agent ?? "")) % MONOGRAM_HUES.length] ?? HUE.amber;
}

// --- IoC contract ---------------------------------------------------------
// The renderer has no Effect runtime, and this module does not boot one:
// React surfaces call the plain synchronous `marks` accessor. The Tag +
// Layer are the *contract* — the seam tests (and any future Effect-backed
// surface) bind against, shaped like the main-process services. Do not
// introduce a ManagedRuntime into the renderer for this.
export interface MarksService {
  readonly glyphFor: (agent?: string) => HarnessGlyph | undefined;
  readonly displayNameFor: (agent?: string) => string;
  readonly hueFor: (agent?: string) => string;
}

const marksImpl: MarksService = {
  glyphFor: harnessGlyphFor,
  displayNameFor: harnessDisplayName,
  hueFor: harnessHue,
};

export class Marks extends Context.Tag("@vellum/Marks")<Marks, MarksService>() {}

export const MarksLive = Layer.succeed(Marks, marksImpl);

/** Sync accessor over the repository — the React path. */
export const marks: MarksService = marksImpl;

/** Everything the HarnessMark tile needs, resolved in one pure step. */
export interface MarkTile {
  readonly glyph: HarnessGlyph | undefined;
  readonly known: boolean; // a real agent string was given (vs the absent-agent mark)
  readonly hue: string; // brand/INK/monogram hue; DIM when no agent
  readonly displayName: string;
  readonly viewBox: string;
  readonly imageSrc?: string;
  readonly paths: ReadonlyArray<string>; // glyph paths normalized to an array
  readonly fillRule: "evenodd" | "nonzero";
}

/** The tile's resolve step, pure and service-parametric for test seams. */
export function markTileFor(agent: string | undefined, service: MarksService = marks): MarkTile {
  const glyph = service.glyphFor(agent);
  const known = Boolean(agent?.trim());
  return {
    glyph,
    known,
    hue: known ? service.hueFor(agent) : DIM,
    displayName: service.displayNameFor(agent),
    viewBox: glyph?.viewBox ?? "0 0 24 24",
    imageSrc: glyph?.imageSrc,
    paths: glyph?.d ? (Array.isArray(glyph.d) ? glyph.d : [glyph.d]) : [],
    fillRule: glyph?.fillRule ?? "nonzero",
  };
}
