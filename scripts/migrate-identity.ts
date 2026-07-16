import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// One-shot migration to the identity model: every node that carried stored
// ether.bindings gets its immutable identity stamped (ether.entity.name) and
// the bindings deleted. Tower key wins as the canonical name; agents take
// their hermes key; anything else falls back to the node's first title line.
// Run once: bun run scripts/migrate-identity.ts

const dir = join(homedir(), ".vellum", "canvases");

interface LegacyBinding {
  readonly source: string;
  readonly ref: { readonly type: string; readonly key: string };
}

for (const file of readdirSync(dir).filter((name) => name.endsWith(".canvas"))) {
  const path = join(dir, file);
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    nodes?: Array<{
      text?: string;
      ether?: {
        entity?: { kind: string; name?: string };
        bindings?: LegacyBinding[];
      };
    }>;
  };
  let changed = 0;
  for (const node of doc.nodes ?? []) {
    const ether = node.ether;
    if (!ether?.bindings) continue;
    const bindings = ether.bindings;
    const hermes = bindings.find((binding) => binding.source === "hermes")?.ref.key;
    const tower = bindings.find((binding) => binding.source === "tower")?.ref.key;
    const kind = ether.entity?.kind ?? (hermes ? "agent" : "project");
    const title = (node.text ?? "").split("\n")[0]?.trim();
    const name =
      ether.entity?.name ??
      (kind === "agent" ? hermes : tower) ??
      (title && title.length > 0 ? title : undefined);
    ether.entity = { kind, ...(name === undefined ? {} : { name }) };
    delete ether.bindings;
    changed += 1;
  }
  if (changed > 0) {
    writeFileSync(path, JSON.stringify(doc, null, 1));
    console.log(`${file}: ${changed} node(s) migrated`);
  } else {
    console.log(`${file}: nothing to migrate`);
  }
}
