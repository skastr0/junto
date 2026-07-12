import { useEffect, useState } from "react";
import { Flag } from "lucide-react";
import type { CanvasDoc, CanvasNode, EtherEdgeKind, EtherFlag } from "@shared/canvas";
import { addEdge } from "../lib/edge-mutations";
import { editFileDetails, editGroupBackground, editLink, editText, renameGroup, toggleFlag } from "../lib/mutations";
import { HUE, withAlpha } from "../lib/theme";
import { nodeTitle, searchText } from "../lib/presentation";

const FLAG_OPTIONS: ReadonlyArray<{ readonly flag: EtherFlag; readonly hue: string }> = [
  { flag: "blocker", hue: HUE.crimson },
  { flag: "attention", hue: HUE.amber },
  { flag: "parked", hue: HUE.violet },
];

export function NodeFieldEditors({ node }: { readonly node: CanvasNode }) {
  const textValue = node.type === "text" ? node.text : "";
  const linkValue = node.type === "link" ? node.url : "";
  const groupLabelValue = node.type === "group" ? node.label ?? "" : "";
  const fileValue = node.type === "file" ? node.file : "";
  const subpathValue = node.type === "file" ? node.subpath ?? "" : "";
  const backgroundValue = node.type === "group" ? node.background ?? "" : "";
  const backgroundStyleValue = node.type === "group" ? node.backgroundStyle ?? "cover" : "cover";
  const [textDraft, setTextDraft] = useState(textValue);
  const [linkDraft, setLinkDraft] = useState(linkValue);
  const [groupLabelDraft, setGroupLabelDraft] = useState(groupLabelValue);
  const [fileDraft, setFileDraft] = useState(fileValue);
  const [subpathDraft, setSubpathDraft] = useState(subpathValue);
  const [backgroundDraft, setBackgroundDraft] = useState(backgroundValue);
  const [backgroundStyleDraft, setBackgroundStyleDraft] = useState<"cover" | "ratio" | "repeat">(backgroundStyleValue);

  useEffect(() => {
    setTextDraft(textValue);
    setLinkDraft(linkValue);
    setGroupLabelDraft(groupLabelValue);
    setFileDraft(fileValue);
    setSubpathDraft(subpathValue);
    setBackgroundDraft(backgroundValue);
    setBackgroundStyleDraft(backgroundStyleValue);
  }, [backgroundStyleValue, backgroundValue, fileValue, groupLabelValue, linkValue, node.id, subpathValue, textValue]);

  const commitText = () => { if (node.type === "text" && textDraft !== textValue) editText(node.id, textDraft); };
  const commitLink = () => { if (node.type === "link" && linkDraft.trim() && linkDraft.trim() !== linkValue) editLink(node.id, linkDraft.trim()); };
  const commitGroupLabel = () => { if (node.type === "group" && groupLabelDraft !== groupLabelValue) renameGroup(node.id, groupLabelDraft.trim()); };
  const commitFile = () => { if (node.type === "file") editFileDetails(node.id, fileDraft, subpathDraft); };
  const commitBackground = (background = backgroundDraft, style = backgroundStyleDraft) => { if (node.type === "group") editGroupBackground(node.id, background, style); };

  return <>
    {node.type === "text" ? <label className="inspector-editor"><span>note content</span><textarea aria-label="Note content" value={textDraft} onChange={(event) => setTextDraft(event.target.value)} onBlur={commitText} onKeyDown={(event) => { if (event.key === "Escape") { setTextDraft(textValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "link" ? <label className="inspector-editor"><span>web reference</span><input aria-label="Link URL" value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)} onBlur={commitLink} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitLink(); event.currentTarget.blur(); } if (event.key === "Escape") { setLinkDraft(linkValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "group" ? <label className="inspector-editor"><span>region label</span><input aria-label="Region label" value={groupLabelDraft} placeholder="unnamed region" onChange={(event) => setGroupLabelDraft(event.target.value)} onBlur={commitGroupLabel} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitGroupLabel(); event.currentTarget.blur(); } if (event.key === "Escape") { setGroupLabelDraft(groupLabelValue); event.currentTarget.blur(); } }} /></label> : null}
    {node.type === "file" ? <div className="inspector-section"><div className="inspector-section__label">file reference</div><div className="inspector-file-fields"><label><span>path</span><input aria-label="File path" value={fileDraft} onChange={(event) => setFileDraft(event.target.value)} onBlur={commitFile} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitFile(); event.currentTarget.blur(); } if (event.key === "Escape") { setFileDraft(fileValue); event.currentTarget.blur(); } }} /></label><label><span>subpath</span><input aria-label="File subpath" value={subpathDraft} placeholder="#section or block" onChange={(event) => setSubpathDraft(event.target.value)} onBlur={commitFile} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitFile(); event.currentTarget.blur(); } if (event.key === "Escape") { setSubpathDraft(subpathValue); event.currentTarget.blur(); } }} /></label></div></div> : null}
    {node.type === "group" ? <div className="inspector-section"><div className="inspector-section__label">background</div><div className="inspector-background"><input aria-label="Region background source" value={backgroundDraft} placeholder="image URL or file path" onChange={(event) => setBackgroundDraft(event.target.value)} onBlur={() => commitBackground()} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitBackground(); event.currentTarget.blur(); } if (event.key === "Escape") { setBackgroundDraft(backgroundValue); event.currentTarget.blur(); } }} /><label><span>fit</span><select aria-label="Region background fit" value={backgroundStyleDraft} onChange={(event) => { const style = event.target.value as "cover" | "ratio" | "repeat"; setBackgroundStyleDraft(style); commitBackground(backgroundDraft, style); }}><option value="cover">cover</option><option value="ratio">contain</option><option value="repeat">repeat</option></select></label></div></div> : null}
  </>;
}

export function NodeFlagControls({ node }: { readonly node: CanvasNode }) {
  const flags = node.ether?.flags ?? [];
  return <div className="inspector-section"><div className="inspector-section__label"><Flag size={11} /> flags</div><div className="inspector-flags">{FLAG_OPTIONS.map(({ flag, hue }) => { const active = flags.includes(flag); return <button key={flag} type="button" className="inspector-flag-toggle" aria-pressed={active} style={{ color: active ? hue : "#68604a", borderColor: active ? withAlpha(hue, 0.5) : "rgba(237,230,218,.12)", background: active ? withAlpha(hue, 0.1) : "rgba(255,255,255,.02)" }} onClick={() => toggleFlag(node.id, flag)}>{flag}</button>; })}</div></div>;
}

export function ConnectEditor({ node, doc, open, onOpenChange }: { readonly node: CanvasNode; readonly doc: CanvasDoc; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const [targetId, setTargetId] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [edgeKind, setEdgeKind] = useState<EtherEdgeKind>("relates");
  const targets = doc.nodes.filter((candidate) => candidate.id !== node.id && candidate.type !== "group");
  const availableTargets = targets.filter((target) => !doc.edges.some((edge) => edge.fromNode === node.id && edge.toNode === target.id));
  const filteredTargets = availableTargets.filter((target) => !targetQuery.trim() || searchText(target).includes(targetQuery.trim().toLowerCase()));
  const connect = () => {
    if (!targetId) return;
    addEdge({ source: node.id, target: targetId, kind: edgeKind });
    setTargetId("");
    setTargetQuery("");
    setEdgeKind("relates");
    onOpenChange(false);
  };
  if (!open) return null;
  return <div className="inspector-connect"><label><span>find a node <em>{filteredTargets.length}/{availableTargets.length}</em></span><input aria-label="Find a node" value={targetQuery} onChange={(event) => setTargetQuery(event.target.value)} placeholder="name, source, or binding" /></label>{availableTargets.length === 0 ? <div className="inspector-connect__empty">No unlinked nodes available.</div> : filteredTargets.length === 0 ? <div className="inspector-connect__empty">No nodes match this filter.</div> : <label><span>connect to</span><select aria-label="Connect to node" value={targetId} onChange={(event) => setTargetId(event.target.value)}><option value="">choose a node</option>{filteredTargets.map((target) => <option key={target.id} value={target.id}>{nodeTitle(target)} · {target.type}</option>)}</select></label>}<label><span>edge kind</span><select aria-label="Edge kind" value={edgeKind} onChange={(event) => setEdgeKind(event.target.value as EtherEdgeKind)}><option value="relates">relates</option><option value="depends">depends</option><option value="blocks">blocks</option></select></label><button disabled={!targetId} onClick={connect}>create edge</button></div>;
}
