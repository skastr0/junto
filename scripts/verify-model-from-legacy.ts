import { Database } from "bun:sqlite";
import { nodeFromLegacyRow, sheetGridFromLegacyRow, wireFromLegacyRow } from "../src/shared/model/from-legacy-row";
const db = new Database(process.argv[2]!, { readonly: true });
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const leaves = (v: unknown, path: string, out: Array<[string, string]>) => {
  if (v === null || v === undefined) return;
  if (Array.isArray(v)) v.forEach((x) => leaves(x, `${path}[]`, out));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, `${path}.${k}`, out);
  else out.push([path, JSON.stringify(v)]);
};
const kinds = new Map<string, number>(), thrown = new Map<string, number>(), lost = new Map<string, number>(), notes = new Map<string, number>();
for (const row of db.query("select d.canvas_name, n.* from canvas_nodes n join canvas_documents d using (canvas_id)").all() as any[]) {
  const ether = row.ether_json ? JSON.parse(row.ether_json) : undefined;
  const tag = `${row.type}/${ether?.entity?.kind ?? (ether?.region ? "region" : "-")}`;
  let node: any;
  try { node = nodeFromLegacyRow(row); sheetGridFromLegacyRow(row); } catch (error) { bump(thrown, `${tag}: ${String(error).replace(/\s+/gu, " ").slice(0, 160)}`); continue; }
  bump(kinds, `${tag} -> ${node.kind}`);
  const have: Array<[string, string]> = []; leaves(node, "", have);
  const values = new Set(have.map(([, v]) => v));
  const src: Array<[string, string]> = [];
  for (const col of ["color", "text_content", "file_path", "file_subpath", "link_url", "group_label", "group_background", "group_background_style"]) leaves(row[col], `col.${col}`, src);
  leaves(ether, "ether", src);
  for (const [path, value] of src) {
    if (path === "ether.entity.kind") continue;
    if (!values.has(value)) bump(lost, `${node.kind}: ${path}`);
  }
  if (node.kind === "agent") {
    if ((row.text_content ?? "").includes("\n")) bump(notes, "agent text has more than one line (rest dropped)");
    if (node.label === "") bump(notes, "agent label came out empty");
    if (ether.terminal?.label !== undefined && ether.terminal.label !== node.label) bump(notes, "agent: terminal.label differs from the label kept");
  }
  if (node.kind === "terminal" && ether.terminal?.label !== undefined && ether.terminal.label !== node.label) bump(notes, "terminal: terminal.label differs from the label kept (label taken from card text)");
}
let wires = 0;
for (const row of db.query("select d.canvas_name, e.* from canvas_edges e join canvas_documents d using (canvas_id)").all() as any[]) {
  try { const w: any = wireFromLegacyRow(row); wires += 1;
    for (const col of ["from_end", "to_end", "color", "label"]) if (row[col] !== null) bump(lost, `wire: col.${col}`);
    const e = JSON.parse(row.ether_json); for (const k of Object.keys(e)) if (!(k in w)) bump(lost, `wire: ether.${k}`);
  } catch (error) { bump(thrown, `wire: ${String(error).replace(/\s+/gu, " ").slice(0, 160)}`); }
}
const show = (t: string, m: Map<string, number>) => { console.log(`\n${t}`); if (!m.size) console.log("  (none)"); for (const [k, c] of [...m].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${k}`); };
show("row -> kind", kinds); show("refused (thrown)", thrown); show("source values that appear nowhere in the result", lost); show("notes", notes);
console.log(`\nwires converted: ${wires}`);
