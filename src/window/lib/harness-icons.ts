import { Context, Layer } from "effect";
import { PROVIDER_MARKS, type ProviderMarkData } from "./provider-marks.generated";
import {
  ALIBABA_ICON,
  CHUTES_ICON,
  CODEBUFF_ICON,
  DEEPGRAM_ICON,
  DEEPSEEK_ICON,
  DOUBAO_ICON,
  JETBRAINS_ICON,
  KIRO_ICON,
  MINIMAX_ICON,
  OLLAMA_ICON,
  PERPLEXITY_ICON,
  POE_ICON,
  SAKANA_ICON,
  SYNTHETIC_ICON,
  T3CHAT_ICON,
  VENICE_ICON,
  VERTEXAI_ICON,
  WARP_ICON,
} from "./official-agent-assets";
import { DIM, INK } from "./theme";

// The provider:agent:icon repository, in three layers:
//
//   data       — PROVIDER_MARKS (monochrome vectors extracted from each
//                provider's own published artwork: site favicon/icon SVGs,
//                official brand assets, provider-controlled repositories)
//                plus CURATED, a small set of overrides and additions —
//                provider-published raster marks where no standalone
//                vector exists, independently sourced vectors absent from
//                the table, and documented monogram fallbacks.
//   facade     — GLYPHS (merged table, curated wins) + ALIASES, queried
//                through harnessGlyphFor / harnessDisplayName / harnessHue.
//   contract   — MarksService / Marks / MarksLive / marks: the Effect-shaped
//                IoC seam (see the comment at MarksService).
//
// Every mark is monochrome and draws in house INK, so a mark reads the same
// in both themes and no vendor colour competes with the canvas's own state
// colours. Each entry keeps the provider's own `viewBox`/`fillRule`.

export interface HarnessGlyph {
  readonly d?: string | ReadonlyArray<string>; // SVG path data, `viewBox` grid
  readonly imageSrc?: string; // exact raster asset when a vendor publishes no standalone vector
  readonly viewBox?: string; // defaults to "0 0 24 24"
  readonly fillRule?: "evenodd"; // defaults to nonzero; ring/hole marks need evenodd
  readonly displayName: string;
}

// Curated entries — additions and overrides that live outside the generated
// monochrome vector table:
//
//   vectors   — independently sourced official marks that predate the
//               table's coverage (googlegemini, pi, prime-agent).
//   raster    — provider-published image assets, embedded as data URLs, for
//               providers that ship no usable standalone monochrome vector.
//   monogram  — known providers with no published mark at all: a bare entry
//               (no `d`/`imageSrc`) preserves the provider's display name and
//               renders the existing initial-tile fallback.
//
// Provenance receipts live in docs/harness-icon-provenance.md.
const CURATED: Readonly<Record<string, HarnessGlyph>> = {
  googlegemini: {
    // Official Gemini sparkle outline from Google's own asset served to
    // gemini.google.com (www.gstatic.com/lamda/images/gemini_sparkle_aurora
    // svg). Antigravity has its own mark in the table.
    d: "M164.93 86.68c-13.56-5.84-25.42-13.84-35.6-24.01-10.17-10.17-18.18-22.04-24.01-35.6-2.23-5.19-4.04-10.54-5.42-16.02C99.45 9.26 97.85 8 96 8s-3.45 1.26-3.9 3.05c-1.38 5.48-3.18 10.81-5.42 16.02-5.84 13.56-13.84 25.43-24.01 35.6-10.17 10.16-22.04 18.17-35.6 24.01-5.19 2.23-10.54 4.04-16.02 5.42C9.26 92.55 8 94.15 8 96s1.26 3.45 3.05 3.9c5.48 1.38 10.81 3.18 16.02 5.42 13.56 5.84 25.42 13.84 35.6 24.01 10.17 10.17 18.18 22.04 24.01 35.6 2.24 5.2 4.04 10.54 5.42 16.02A4.03 4.03 0 0 0 96 184c1.85 0 3.45-1.26 3.9-3.05 1.38-5.48 3.18-10.81 5.42-16.02 5.84-13.56 13.84-25.42 24.01-35.6 10.17-10.17 22.04-18.18 35.6-24.01 5.2-2.24 10.54-4.04 16.02-5.42A4.03 4.03 0 0 0 184 96c0-1.85-1.26-3.45-3.05-3.9-5.48-1.38-10.81-3.18-16.02-5.42",
    viewBox: "0 0 192 192",
    displayName: "Gemini",
  },
  pi: {
    // Official pi.dev mark: square-spiral Pi + dot, monochrome.
    d: [
      "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z",
      "M517.36 400H634.72V634.72H517.36Z",
    ],
    viewBox: "0 0 800 800",
    fillRule: "evenodd",
    displayName: "Pi",
  },
  "prime-agent": {
    // Official Prime Intellect butterfly mark from the prime-agent repo's
    // brand assets (monochrome; the source SVG fills white for dark fields).
    d: [
      "m 123.322,84.092671 c -0.192,0.0065 -0.43,0.0147 -0.74,0.0147 l -0.018,-0.0247 c -0.873,0.1977 -1.958,0.1266 -3.067,0.0537 -3.29,-0.216 -6.799,-0.4465 -5.635,6.2824 0.259,1.4822 -1.538,1.8465 -2.73,1.9082 -3.384,0.1853 -6.78,0.2594 -10.171,0.1915 -0.641,-0.0106 -1.2979,-0.5506 -1.8904,-1.0388 -0.1022,-0.0844 -0.2034,-0.1673 -0.3016,-0.2457 -0.1052,-0.0865 0.2898,-1.2042 0.4942,-1.2166 3.3078,-0.1931 4.5068,-2.4361 5.7028,-4.6724 0.603,-1.1253 1.204,-2.2488 2.072,-3.1088 7.856,-7.7874 15.878,-15.4265 25.054,-21.7008 0.895,-0.6114 1.989,-1.1733 2.73,-0.1111 0.571,0.8205 0.036,1.2854 -0.512,1.7627 -0.24,0.2088 -0.482,0.4199 -0.637,0.6642 -0.554,0.8792 -1.538,1.5273 -2.514,2.1717 -1.92,1.2655 -3.82,2.5172 -2.408,5.4798 1.225,2.5651 0.129,3.0202 -1.555,3.7198 l -0.069,0.0287 c -0.72,0.3021 -1.458,0.5764 -2.194,0.8506 -1.568,0.5835 -3.134,1.1662 -4.537,2.0149 -1.408,0.8522 -2.081,2.5134 0.222,3.4954 5.033,2.1428 18.064,-1.2784 20.608,-5.9965 2.377,-4.4147 5.931,-7.6891 9.481,-10.9611 1.992,-1.836 3.984,-3.6712 5.767,-5.7067 3.844,-4.3849 8.344,-8.1939 12.846,-12.005 2.239,-1.8944 4.478,-3.78938 6.637,-5.75588 1.624,-1.48207 2.297,-3.43353 1.026,-5.56412 -1.267,-2.118215 -3.416,-2.402287 -5.435,-1.926802 -13.309,3.130982 -26.166,7.355122 -37.585,15.241302 -18.23,12.5919 -36.4911,25.1406 -54.9002,37.4669 -6.2743,4.2056 -10.0723,2.1491 -12.1657,-5.1318 -4.6502,-16.1676 -11.4681,-30.2664 -31.0569,-32.4587 -7.1574,-0.8028 -12.4066,3.6807 -11.3692,10.7949 0.5249,3.6065 0.0495,7.003 -1.6858,10.3872 -0.3827,0.7472 -0.7689,1.4947 -1.1556,2.243 -2.672,5.1706 -5.3671,10.3857 -7.0394,15.8885 -0.1399,0.4602 -0.3002,0.9444 -0.4654,1.4437 -1.4909,4.5052 -3.3862,10.2323 5.659,10.5492 0.3705,0.0123 1.0808,0.944799 0.9943,1.290699 -0.1976,0.8213 -0.5991,1.797 -1.2413,2.2725 -8.6705,6.3917 -15.79706,14.1294 -18.860151,24.5971 -1.550066,5.2865 -0.524909,10.7765 3.989391,14.8705 3.22984,2.928 7.35516,4.625 10.97396,2.162 3.3009,-2.247 6.9232,-3.754 10.538,-5.259 3.1819,-1.324 6.358,-2.646 9.3041,-4.468 0.7101,-0.439 1.5727,-0.841 2.4456,-1.248 2.4138,-1.1228 4.9063,-2.2843 4.4709,-4.3841 -0.6854,-3.2908 -4.1623,-6.3418 -7.0586,-8.7384 -2.8716,-2.3769 -10.1897,-18.3411 -9.3189,-22.176099 1.2193,-5.3704 3.9645,-10.0201 6.7125,-14.6744 2.3458,-3.9731 4.6935,-7.9497 6.0956,-12.3806 0.5804,-1.828 2.8037,-2.8284 4.9466,-2.0997 1.4543,0.4928 1.2068,1.8278 0.9762,3.0715 -0.0063,0.0344 -0.0127,0.0685 -0.019,0.1027 -0.8688,4.7802 -1.721,9.566 -2.5733,14.3517 -0.4261,2.3924 -0.8521,4.7847 -1.2803,7.1762 -0.2717,1.5316 0.2038,2.7544 1.7909,3.0631 3.0569,0.599 2.989,1.9762 1.6119,4.341499 -1.4636,2.5072 -1.6674,5.5703 -0.0309,7.8861 1.6427,2.3282 4.3908,2.8161 7.1821,1.4204 1.7415,-0.8646 3.094,-0.0927 3.0755,1.6612 -0.1112,9.3688 3.8103,7.2561 8.584,3.1681 0.439,-0.3763 1.0373,-0.5846 1.6152,-0.7857 0.1048,-0.0366 0.2091,-0.0728 0.3116,-0.1098 0.4529,-0.1616 0.9062,-0.3224 1.3595,-0.4833 8.986,-3.1884 17.9603,-6.3725 23.0334,-15.573099 0.392,-0.7187 1.6783,-1.0669 2.6795,-1.3377 0.057,-0.0154 0.113,-0.0307 0.1681,-0.0456 5.8013,-1.5766 11.7248,-1.6001 17.6438,-1.6237 4.445,-0.0176 8.888,-0.0352 13.277,-0.7107 4.329,-0.667 9.047,-3.1928 9.084,-7.3736 0.035,-3.3707 -2.546,-3.1612 -5.123,-2.9519 -1.115,0.0906 -2.231,0.1811 -3.134,-0.0185 -0.182,-0.0381 -0.375,-0.0316 -0.686,-0.0209 z",
      "m 55.1325,131.29447 c -1.0745,7.1515 1.6551,13.2715 12.8266,13.1915 h -0.0062 c 9.5413,-0.389 20.3365,-6.164 30.8838,-13.5492 6.9653,-4.8787 12.9873,-10.0236 16.8903,-17.6253 2.872,-5.5889 1.395,-10.0723 -2.933,-13.993799 -1.908,-1.7291 -3.73,-1.9205 -5.867,0.1667 -7.5842,7.423099 -17.0261,11.474299 -26.7218,15.550099 -2.4706,1.0393 -5.2847,1.5582 -8.1187,2.0809 -7.5511,1.3924 -15.2431,2.8103 -16.954,14.1791 z",
    ],
    viewBox: "0 0 178 178",
    displayName: "Prime Agent",
  },
  // --- provider-published raster marks (no standalone monochrome vector) ---
  alibaba: {
    imageSrc: ALIBABA_ICON,
    displayName: "Alibaba",
  },
  chutes: {
    imageSrc: CHUTES_ICON,
    displayName: "Chutes",
  },
  codebuff: {
    imageSrc: CODEBUFF_ICON,
    displayName: "Codebuff",
  },
  deepgram: {
    imageSrc: DEEPGRAM_ICON,
    displayName: "Deepgram",
  },
  deepseek: {
    imageSrc: DEEPSEEK_ICON,
    displayName: "DeepSeek",
  },
  doubao: {
    imageSrc: DOUBAO_ICON,
    displayName: "Doubao",
  },
  jetbrains: {
    imageSrc: JETBRAINS_ICON,
    displayName: "JetBrains",
  },
  kiro: {
    imageSrc: KIRO_ICON,
    displayName: "Kiro",
  },
  minimax: {
    imageSrc: MINIMAX_ICON,
    displayName: "MiniMax",
  },
  ollama: {
    imageSrc: OLLAMA_ICON,
    displayName: "Ollama",
  },
  perplexity: {
    imageSrc: PERPLEXITY_ICON,
    displayName: "Perplexity",
  },
  poe: {
    imageSrc: POE_ICON,
    displayName: "Poe",
  },
  sakana: {
    imageSrc: SAKANA_ICON,
    displayName: "Sakana AI",
  },
  synthetic: {
    imageSrc: SYNTHETIC_ICON,
    displayName: "Synthetic",
  },
  t3chat: {
    imageSrc: T3CHAT_ICON,
    displayName: "T3 Chat",
  },
  venice: {
    imageSrc: VENICE_ICON,
    displayName: "Venice",
  },
  vertexai: {
    imageSrc: VERTEXAI_ICON,
    displayName: "Vertex AI",
  },
  warp: {
    imageSrc: WARP_ICON,
    displayName: "Warp",
  },
  // --- no published mark: bare entry keeps the display name, tile monograms ---
  clawrouter: { displayName: "Clawrouter" },
  commandcode: { displayName: "Commandcode" },
  crof: { displayName: "Crof" },
  crossmodel: { displayName: "CrossModel" },
  litellm: { displayName: "LiteLLM" },
  llmproxy: { displayName: "LLM Proxy" },
  mimo: { displayName: "Mimo" },
  sub2api: { displayName: "Sub2api" },
};

// Brand casing for generated ids where plain capitalization misreads the
// name. Anything not listed displays as its id with the first letter raised.
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  elevenlabs: "ElevenLabs",
  fx: "fx",
  omp: "Oh My Pi",
  openai: "OpenAI",
  opencode: "OpenCode",
  opencodego: "OpenCode Go",
  openrouter: "OpenRouter",
  stepfun: "StepFun",
  zai: "Z.AI",
};

const capitalize = (id: string): string => id.charAt(0).toUpperCase() + id.slice(1);

// A generated mark is monochrome source data; consumers assign the ink.
const fromProviderMark = (id: string, mark: ProviderMarkData): HarnessGlyph => ({
  d: mark.paths,
  viewBox: mark.viewBox,
  fillRule: mark.fillRule,
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
// zed, warp, deepseek, mistral, perplexity, opencodego, …)
// need no entry — they pass through to the generated table directly.
const ALIASES: Readonly<Record<string, string>> = {
  agy: "antigravity",
  "antigravity-cli": "antigravity",
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
  "opencode-go": "opencodego",
  xai: "grok",
  ampcode: "amp",
  cognition: "devin",
  "devin cli": "devin",
  "cursor agent": "cursor",
  "cursor-agent": "cursor",
  "pi coding agent": "pi",
  "pi-coding-agent": "pi",
  "prime agent": "prime-agent",
  "kimi code": "kimi",
  "muse code": "muse",
  "oh my pi": "omp",
  "oh-my-pi": "omp",
  "hermes agent": "hermes",
  nous: "hermes",
  "nous research": "hermes",
};

const normalize = (agent: string): string => agent.trim().toLowerCase().replace(/\s+/g, " ");

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

/** Mark hue for an agent: house INK for every mark and monogram alike. */
export function harnessHue(_agent?: string): string {
  return INK;
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

export class Marks extends Context.Service<Marks, MarksService>()("@junto/Marks") {}

export const MarksLive = Layer.succeed(Marks, marksImpl);

/** Sync accessor over the repository — the React path. */
export const marks: MarksService = marksImpl;

/** Everything the HarnessMark tile needs, resolved in one pure step. */
export interface MarkTile {
  readonly glyph: HarnessGlyph | undefined;
  readonly known: boolean; // a real agent string was given (vs the absent-agent mark)
  readonly hue: string; // INK; DIM when no agent
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
