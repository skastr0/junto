import { Redacted } from "effect";
import type { CommandLine } from "effect/process";

/** A command word as the process receives it: a redacted word yields its value. */
export const wordText = (word: CommandLine.Word): string => (typeof word === "string" ? word : Redacted.value(word));

/** The words of a command, as the process receives them. */
export const wordsText = (words: ReadonlyArray<CommandLine.Word>): string[] => words.map(wordText);
