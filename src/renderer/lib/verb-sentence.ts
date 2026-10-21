import type { Verb } from "@shared/physics";

/**
 * One product sentence per verb. The verb word is the product word; this
 * table is only the grammar around it. Every template is `{from} … {to}`
 * in stored edge order — `fromNode` is the verb's semantic source.
 */
const VERB_SENTENCE = {
  messages: "{from} messages {to}",
  navigates: "{from} drives {to}",
  flows: "{from} flows into {to}",
} as const satisfies Record<Verb, string>;

export const verbSentence = (verb: Verb, from: string, to: string): string =>
  VERB_SENTENCE[verb].replace("{from}", from).replace("{to}", to);
