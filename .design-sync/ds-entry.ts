// design-sync DS entry — seed scope: foundations + ui primitives + canvas
// nodes + inspector (node/edge settings) + RTS bar. Operator-trimmed 2026-08-02.
export { CanvasStage, SeedState } from "./ds-extras";
export { ConnectEditor, EdgeBoardNotifyToggle, EdgeCapabilitySection, EdgeCriteriaEditor, EdgePortsAttenuator, EdgeRelayStateToggle, NodeCapabilityInventory, NodeFieldEditors, NodeFlagControls, NodePlacementSection, RegionBackgroundEditor, RegionBriefingEditor, RegionDefaultsControl, RegionHoldControl } from "../src/renderer/components/InspectorFields";
export { InspectorPanel } from "../src/renderer/components/InspectorPanel";
export { ClaimedTaskStrip } from "../src/renderer/components/nodes/ClaimedTaskStrip";
export { ExecutionCardHeader } from "../src/renderer/components/nodes/ExecutionCardHeader";
export { FileNode } from "../src/renderer/components/nodes/FileNode";
export { GroupNode } from "../src/renderer/components/nodes/GroupNode";
export { LinkNode } from "../src/renderer/components/nodes/LinkNode";
export { NodeShell } from "../src/renderer/components/nodes/NodeShell";
export { TextNode } from "../src/renderer/components/nodes/TextNode";
export { KindSurface } from "../src/renderer/components/rts/KindSurface";
export { RtsBottomBar } from "../src/renderer/components/rts/RtsBottomBar";
export { EdgeCommandCard, EdgePairStrip, KindActions, KindKey, KindStrip, PauseScopeKey, RegionPauseDot } from "../src/renderer/components/rts/RtsControls";
export { StoppageRank } from "../src/renderer/components/rts/StoppageRank";
export { Button } from "../src/renderer/components/ui/Button";
export { Chip } from "../src/renderer/components/ui/Chip";
export { Dropdown } from "../src/renderer/components/ui/Dropdown";
export { Eyebrow } from "../src/renderer/components/ui/Eyebrow";
export { FieldLabel, Input, Select, Textarea } from "../src/renderer/components/ui/Field";
export { HelpMap, HelpMapGroup, HelpMapKeys, HelpMapPrimer, HelpMapPrimerBlock } from "../src/renderer/components/ui/HelpMap";
export { IconButton } from "../src/renderer/components/ui/IconButton";
export { Kbd } from "../src/renderer/components/ui/Kbd";
export { OverlayHeader } from "../src/renderer/components/ui/OverlayHeader";
export { StatusDot } from "../src/renderer/components/ui/StatusDot";
export { ToolbarPill } from "../src/renderer/components/ui/ToolbarPill";
