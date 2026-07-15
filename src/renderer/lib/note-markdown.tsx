import type { ReactNode } from "react";
import { createElement } from "react";

// Lightweight, dependency-free markdown for freeform note nodes.
// Raw source is stored; this renders a safe subset when the node is unselected.
// Never injects HTML — every leaf is a text node.

type InlineToken =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "strong"; readonly children: ReadonlyArray<InlineToken> }
  | { readonly kind: "em"; readonly children: ReadonlyArray<InlineToken> }
  | { readonly kind: "link"; readonly href: string; readonly children: ReadonlyArray<InlineToken> };

type Block =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly children: ReadonlyArray<InlineToken> }
  | { readonly kind: "paragraph"; readonly children: ReadonlyArray<InlineToken> }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: ReadonlyArray<ReadonlyArray<InlineToken>> }
  | { readonly kind: "code"; readonly lang: string; readonly value: string }
  | { readonly kind: "quote"; readonly children: ReadonlyArray<InlineToken> }
  | { readonly kind: "hr" };

// Links allow one level of nested parens in the href (e.g. wikipedia URLs).
const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\((?:[^()\s]+|\([^)]*\))+\))/g;

const isSafeHref = (href: string): boolean =>
  /^(https?:|mailto:|\/|#)/i.test(href);

export function parseInline(source: string): ReadonlyArray<InlineToken> {
  if (!source) return [];
  const tokens: InlineToken[] = [];
  let last = 0;
  for (const match of source.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "text", value: source.slice(last, index) });
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push({ kind: "strong", children: parseInline(token.slice(2, -2)) });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      tokens.push({ kind: "em", children: parseInline(token.slice(1, -1)) });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push({ kind: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const close = token.indexOf("](");
      const label = token.slice(1, close);
      const href = token.slice(close + 2, -1);
      tokens.push({
        kind: "link",
        href: isSafeHref(href) ? href : "#",
        children: parseInline(label),
      });
    }
    last = index + token.length;
  }
  if (last < source.length) tokens.push({ kind: "text", value: source.slice(last) });
  return tokens;
}

function parseListItemBody(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "");
}

export function parseBlocks(source: string): ReadonlyArray<Block> {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      blocks.push({ kind: "code", lang, value: body.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        children: parseInline(heading[2]!.trim()),
      });
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: Array<ReadonlyArray<InlineToken>> = [];
      while (i < lines.length) {
        const current = lines[i] ?? "";
        if (!(ordered ? /^\s*\d+\.\s+/.test(current) : /^\s*[-*+]\s+/.test(current))) break;
        items.push(parseInline(parseListItemBody(current)));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", children: parseInline(body.join(" ")) });
      continue;
    }

    const body: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (!current.trim()) break;
      if (current.startsWith("```")) break;
      if (/^#{1,3}\s+/.test(current)) break;
      if (/^\s*[-*+]\s+/.test(current) || /^\s*\d+\.\s+/.test(current)) break;
      if (/^\s*>\s?/.test(current)) break;
      if (/^---+$/.test(current.trim()) || /^\*\*\*+$/.test(current.trim())) break;
      body.push(current);
      i += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(body.join(" ")) });
  }

  return blocks;
}

function renderInline(tokens: ReadonlyArray<InlineToken>, keyPrefix: string): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (token.kind) {
      case "text":
        return token.value;
      case "code":
        return <code key={key} className="note-md__code">{token.value}</code>;
      case "strong":
        return <strong key={key}>{renderInline(token.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(token.children, key)}</em>;
      case "link":
        return (
          <a
            key={key}
            className="note-md__link"
            href={token.href}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(event) => event.stopPropagation()}
          >
            {renderInline(token.children, key)}
          </a>
        );
    }
  });
}

export function NoteMarkdown({ source }: { readonly source: string }) {
  const blocks = parseBlocks(source);
  if (blocks.length === 0) {
    return <div className="note-md note-md--empty">empty note</div>;
  }

  return (
    <div className="note-md">
      {blocks.map((block, index) => {
        const key = `b-${index}`;
        switch (block.kind) {
          case "heading":
            return createElement(
              `h${block.level}`,
              { key, className: `note-md__h note-md__h${block.level}` },
              renderInline(block.children, key),
            );
          case "paragraph":
            return <p key={key} className="note-md__p">{renderInline(block.children, key)}</p>;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={key} className="note-md__list">
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`} className="note-md__li">
                    {renderInline(item, `${key}-${itemIndex}`)}
                  </li>
                ))}
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={key} className="note-md__pre" data-lang={block.lang || undefined}>
                <code>{block.value}</code>
              </pre>
            );
          case "quote":
            return <blockquote key={key} className="note-md__quote">{renderInline(block.children, key)}</blockquote>;
          case "hr":
            return <hr key={key} className="note-md__hr" />;
        }
      })}
    </div>
  );
}
