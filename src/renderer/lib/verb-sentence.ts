import type { Verb } from "@shared/physics";

/**
 * One product sentence per verb. The verb word is the product word; this
 * table is only the grammar around it. Every template is `{from} … {to}`
 * in stored edge order — `fromNode` is the verb's semantic source.
 */
const VERB_SENTENCE = {
  messages: "{from} messages {to}",
  manages: "{from} manages {to}",
  contributes: "{from} contributes to {to}",
  works: "{from} works {to}",
  escalates: "{from} escalates to {to}",
  publishes: "{from} publishes to {to}",
  participates: "{from} takes part in {to}",
  reads: "{from} reads {to}",
  edits: "{from} edits {to}",
  navigates: "{from} drives {to}",
  feeds: "{from} feeds {to}",
  fires: "{from} fires {to}",
  announces: "{from} announces to {to}",
  enqueues: "{from} enqueues onto {to}",
  wakes: "{from} wakes {to}",
  flags: "{from} flags {to}",
  chains: "{from} chains into {to}",
} as const satisfies Record<Verb, string>;

export const verbSentence = (verb: Verb, from: string, to: string): string =>
  VERB_SENTENCE[verb].replace("{from}", from).replace("{to}", to);
