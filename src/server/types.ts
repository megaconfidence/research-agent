// Shared types for the ResearchAgent and the chat UI.
//
// `ResearchState` is what the Durable Object persists and broadcasts to
// connected chat clients via `useAgent`'s state subscription. It drives
// the live progress sidebar.
//
// `EmailMessageMeta` is attached to UIMessages we synthesise from inbound
// emails so the chat UI can badge them with a "📧 from <address>" pill.

export type SourceKind = "search-result" | "read" | "extract" | "screenshot";

export type Source = {
  id: string;
  url: string;
  title: string;
  snippet?: string;
  kind: SourceKind;
  timestamp: number;
};

export type Finding = {
  id: string;
  text: string;
  sourceUrls: string[];
  timestamp: number;
};

export type Status = "idle" | "researching" | "complete";

export type ResearchState = {
  topic: string | null;
  status: Status;
  sources: Source[];
  findings: Finding[];
  startedAt: number | null;
  lastError: string | null;
};

export const INITIAL_STATE: ResearchState = {
  topic: null,
  status: "idle",
  sources: [],
  findings: [],
  startedAt: null,
  lastError: null
};

/**
 * Extra fields we attach to a UIMessage when it was created from an inbound
 * email. Picked up by the chat UI to render a "📧 from <address>" badge.
 */
export type EmailMessageMeta = {
  source: "email";
  from: string;
  subject: string;
  receivedAt: number;
};
