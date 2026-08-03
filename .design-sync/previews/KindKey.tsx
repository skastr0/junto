import { KindKey } from "@skastr0/vellum";
import {
  ArrowLeft,
  ArrowRight,
  Inbox,
  ListChecks,
  Pause,
  Play,
  SlidersHorizontal,
  Terminal,
  Trash2,
} from "lucide-react";

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      background: "var(--color-ground)",
      padding: 20,
      display: "flex",
      alignItems: "flex-start",
      gap: 20,
      flexWrap: "wrap",
    }}
  >
    {children}
  </div>
);

const Labeled = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
    {children}
    <span
      style={{
        fontSize: 9,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "rgba(143,163,176,0.85)",
      }}
    >
      {label}
    </span>
  </div>
);

export const States = () => (
  <Frame>
    <Labeled label="default">
      <KindKey label="Pause node" title="pause node — its seats stop acting">
        <Pause size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="active">
      <KindKey label="Toggle arrow at source" active title="arrowhead on the from end">
        <ArrowLeft size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="danger">
      <KindKey label="Delete relation" danger title="delete relation">
        <Trash2 size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="disabled">
      <KindKey label="Busy" disabled title="busy">
        <SlidersHorizontal size={12} />
      </KindKey>
    </Labeled>
  </Frame>
);

export const IconGallery = () => (
  <Frame>
    <Labeled label="resume">
      <KindKey label="Resume node">
        <Play size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="terminal">
      <KindKey label="Open terminal">
        <Terminal size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="tasks">
      <KindKey label="Open task board">
        <ListChecks size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="requests">
      <KindKey label="Open request inbox">
        <Inbox size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="criteria">
      <KindKey label="Edit stop criteria">
        <SlidersHorizontal size={12} />
      </KindKey>
    </Labeled>
    <Labeled label="arrow target">
      <KindKey label="Toggle arrow at target" active>
        <ArrowRight size={12} />
      </KindKey>
    </Labeled>
  </Frame>
);
