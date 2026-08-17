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
// pi, prime-agent, and muse have NO generated mark — their entries are the
// official brand vectors (or, for muse, a crafted monogram — see
// docs/research/agent-cli-sweep/icons.md for provenance receipts).
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
    // Current official Kimi logomark (the K mark), from kimi.com's own icon
    // bundle. Supersedes the earlier lowercase "kimi" wordmark path, whose
    // provenance was never recorded.
    d: "M202.197333 444.928c-17.365333 17.365333-46.506667 14.933333-56.192-7.637333a221.738667 221.738667 0 0 1 360.362667-244.352l179.2 179.2A37.973333 37.973333 0 0 1 631.893333 425.813333l-179.2-179.2a145.664 145.664 0 0 0-241.365333 148.650667c5.632 17.194667 3.669333 36.864-9.088 49.621333z m140.714667 157.738667a37.973333 37.973333 0 0 0 0 53.76l174.677333 174.634666a221.653333 221.653333 0 0 0 363.52-236.672c-9.045333-23.552-39.04-26.538667-56.917333-8.704-12.373333 12.416-14.72 31.36-9.856 48.213334a145.664 145.664 0 0 1-242.986667 143.445333l-174.72-174.677333a37.973333 37.973333 0 0 0-53.717333 0zM448.725333 512a63.317333 63.317333 0 1 0 126.592 0 63.317333 63.317333 0 0 0-126.634666 0zM380.373333 330.112l-187.477333 187.477333a221.653333 221.653333 0 0 0 221.781333 368.64c25.429333-7.765333 29.610667-39.424 10.794667-58.197333-11.690667-11.733333-29.226667-14.634667-45.44-11.221333A145.664 145.664 0 0 1 246.613333 571.306667l187.477334-187.477334a37.973333 37.973333 0 1 0-53.76-53.717333z m263.168 363.776a37.973333 37.973333 0 1 1-53.76-53.76l187.52-187.477333a145.664 145.664 0 0 0-133.418666-245.461334c-16.213333 3.413333-33.749333 0.512-45.482667-11.221333-18.773333-18.773333-14.634667-50.432 10.794667-58.24a221.653333 221.653333 0 0 1 221.866666 368.64l-187.52 187.52z",
    viewBox: "0 0 1024 1024",
    hex: "#000000",
    displayName: "Kimi",
  },
  pi: {
    // Official pi.dev mark: square-spiral Pi + dot, monochrome.
    d: [
      "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29Z M282.65 282.65V400H400V282.65Z",
      "M517.36 400H634.72V634.72H517.36Z",
    ],
    viewBox: "0 0 800 800",
    fillRule: "evenodd",
    hex: "#000000",
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
    hex: "#000000",
    displayName: "Prime Agent",
  },
  muse: {
    // No official monochrome vector is publicly available (site auth-gated,
    // no repo/npm, installer ships the binary only) — crafted monogram M
    // fallback per docs/research/agent-cli-sweep/icons.md.
    d: [
      "M8.3 20.5L8.3 5.5L3.7 5.5L3.7 20.5Z",
      "M4.25 7L10.25 14L13.75 11L7.75 4Z",
      "M13.75 14L19.75 7L16.25 4L10.25 11Z",
      "M15.7 5.5L15.7 20.5L20.3 20.5L20.3 5.5Z",
    ],
    hex: "#000000",
    displayName: "Muse",
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
  "devin cli": "devin",
  "cursor agent": "cursor",
  "cursor-agent": "cursor",
  "pi coding agent": "pi",
  "pi-coding-agent": "pi",
  "prime agent": "prime-agent",
  "kimi code": "kimi",
  "muse code": "muse",
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

export class Marks extends Context.Service<Marks, MarksService>()("@vellum/Marks") {}

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
