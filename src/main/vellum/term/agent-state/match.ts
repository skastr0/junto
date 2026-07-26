/**
 * Gate algebra for seat rule matchers.
 * contains (AND, case-insensitive) + regex + line_regex + all/any/not trees.
 */

import {
  afterLastHorizontalRule,
  abovePromptBox,
  bottomNonEmptyLines,
  extractRegion,
  footerLine,
  promptBoxBody,
} from "../observer/regions";
import type { ObserverGridSnapshot } from "../observer/types";
import type { SeatMatcher, SeatRule, SeatRuleRegion } from "./types";

const MAX_GATE_DEPTH = 8;

const regexCache = new Map<string, RegExp>();

const compileRegex = (source: string): RegExp | null => {
  const cached = regexCache.get(source);
  if (cached) return cached;
  try {
    const re = new RegExp(source, "u");
    regexCache.set(source, re);
    return re;
  } catch {
    return null;
  }
};

export const regionLines = (
  snapshot: ObserverGridSnapshot,
  region: SeatRuleRegion,
  regionN = 5,
): readonly string[] => {
  switch (region) {
    case "osc_title":
      return snapshot.signals.title ? [snapshot.signals.title] : [];
    case "osc9":
      return snapshot.signals.osc9 ? [snapshot.signals.osc9] : [];
    case "whole_recent":
      return snapshot.lines;
    case "bottom_non_empty_lines":
      return bottomNonEmptyLines(snapshot.lines, regionN);
    case "footer_line": {
      const f = footerLine(snapshot.lines);
      return f ? [f] : [];
    }
    case "after_last_horizontal_rule":
      return afterLastHorizontalRule(snapshot.lines);
    case "prompt_box_body":
      return promptBoxBody(snapshot.lines);
    case "above_prompt_box":
      return abovePromptBox(snapshot.lines);
    default:
      return extractRegion(snapshot.lines, region, regionN);
  }
};

export const regionText = (lines: readonly string[]): string =>
  lines.join("\n");

const hasPositiveMatcher = (m: SeatMatcher): boolean => {
  if (m.contains && m.contains.length > 0) return true;
  if (m.regex && m.regex.length > 0) return true;
  if (m.lineRegex && m.lineRegex.length > 0) return true;
  if (m.all && m.all.some(hasPositiveMatcher)) return true;
  if (m.any && m.any.some(hasPositiveMatcher)) return true;
  // bare `not` is not positive
  return false;
};

export const matcherMatches = (
  matcher: SeatMatcher,
  text: string,
  lines: readonly string[],
  depth = 0,
): boolean => {
  if (depth > MAX_GATE_DEPTH) return false;
  if (!hasPositiveMatcher(matcher) && !(matcher.not && matcher.not.length > 0)) {
    // Empty matcher matches everything (used carefully by packs).
    if (!matcher.not?.length && !matcher.all?.length && !matcher.any?.length) {
      return true;
    }
  }

  const lower = text.toLowerCase();

  if (matcher.contains) {
    for (const needle of matcher.contains) {
      if (!lower.includes(needle.toLowerCase())) return false;
    }
  }

  if (matcher.regex) {
    for (const source of matcher.regex) {
      const re = compileRegex(source);
      if (!re || !re.test(text)) return false;
    }
  }

  if (matcher.lineRegex) {
    for (const source of matcher.lineRegex) {
      const re = compileRegex(source);
      if (!re) return false;
      let hit = false;
      for (const line of lines) {
        if (re.test(line)) {
          hit = true;
          break;
        }
      }
      if (!hit) return false;
    }
  }

  if (matcher.all) {
    for (const child of matcher.all) {
      if (!matcherMatches(child, text, lines, depth + 1)) return false;
    }
  }

  if (matcher.any && matcher.any.length > 0) {
    let anyHit = false;
    for (const child of matcher.any) {
      if (matcherMatches(child, text, lines, depth + 1)) {
        anyHit = true;
        break;
      }
    }
    if (!anyHit) return false;
  }

  if (matcher.not) {
    for (const child of matcher.not) {
      if (matcherMatches(child, text, lines, depth + 1)) return false;
    }
  }

  return true;
};

export const ruleMatches = (
  rule: SeatRule,
  snapshot: ObserverGridSnapshot,
): boolean => {
  const lines = regionLines(snapshot, rule.region, rule.regionN ?? 5);
  const text = regionText(lines);
  // OSC regions with empty payload never match positive rules.
  if (
    (rule.region === "osc_title" || rule.region === "osc9") &&
    text.length === 0
  ) {
    return false;
  }
  return matcherMatches(rule.matchers, text, lines);
};
