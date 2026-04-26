import {
  Suspense,
  useCallback,
  useState,
  useEffect,
  useRef,
  useMemo
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import type { MCPServersState } from "agents";
import type { ResearchAgent } from "./server";
import {
  Badge,
  Button,
  Empty,
  InputArea,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Toasty, useKumoToastManager } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BugIcon,
  PlugsConnectedIcon,
  PlusIcon,
  SignInIcon,
  XIcon,
  WrenchIcon,
  PaperclipIcon,
  ImageIcon,
  AtomIcon,
  MagnifyingGlassIcon,
  BookOpenTextIcon,
  CameraIcon,
  DatabaseIcon,
  LightbulbIcon,
  GlobeIcon,
  QuotesIcon,
  CaretDownIcon,
  ArrowSquareOutIcon,
  HourglassMediumIcon,
  CheckIcon,
  ListBulletsIcon,
  WarningIcon,
  SidebarIcon,
  EnvelopeIcon
} from "@phosphor-icons/react";

// ── Shared types (mirror server.ts) ───────────────────────────────────

type SourceKind = "search-result" | "read" | "extract" | "screenshot";

type Source = {
  id: string;
  url: string;
  title: string;
  snippet?: string;
  kind: SourceKind;
  timestamp: number;
};

type Finding = {
  id: string;
  text: string;
  sourceUrls: string[];
  timestamp: number;
};

type ResearchState = {
  topic: string | null;
  status: "idle" | "researching" | "complete";
  sources: Source[];
  findings: Finding[];
  startedAt: number | null;
  lastError: string | null;
};

const INITIAL_STATE: ResearchState = {
  topic: null,
  status: "idle",
  sources: [],
  findings: [],
  startedAt: null,
  lastError: null
};

// ── Utilities ─────────────────────────────────────────────────────────

function relTime(ts: number | null) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const TOOL_PROMPTS: Array<{ label: string; query: string }> = [
  {
    label: "Compare AI code editors",
    query:
      "Research and compare the leading AI-powered code editors as of April 2026 (Cursor, Cline, Windsurf, GitHub Copilot, Zed). Cover features, pricing, agent quality, and recent reviews. End with a recommendation matrix."
  },
  {
    label: "Fusion energy startups",
    query:
      "What are the most promising commercial fusion energy startups in 2026? Track funding rounds, technical milestones (NIF ignition, ITER updates), and projected timelines to grid power."
  },
  {
    label: "Cloudflare Browser Run brief",
    query:
      "Build a comprehensive product brief on Cloudflare Browser Run: what it is, how pricing works, integration methods, common use cases, and how it compares to competitors like Browserbase and Browserless."
  },
  {
    label: "Long COVID treatments",
    query:
      "What does the latest peer-reviewed research say about long COVID treatments and management strategies in 2025–2026? Be specific about which interventions have evidence and which remain unproven."
  }
];

// ── Attachments ───────────────────────────────────────────────────────

interface Attachment {
  id: string;
  file: File;
  preview: string;
  mediaType: string;
}

function createAttachment(file: File): Attachment {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    preview: URL.createObjectURL(file),
    mediaType: file.type || "application/octet-stream"
  };
}

function fileToDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Theme toggle ──────────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );
  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);
  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

// ── Tool rendering ────────────────────────────────────────────────────

const RESEARCH_TOOLS: Record<
  string,
  {
    label: string;
    Icon: React.ComponentType<{ size?: number; className?: string }>;
    tone: string;
  }
> = {
  web_search: {
    label: "Web Search",
    Icon: MagnifyingGlassIcon,
    tone: "text-sky-500"
  },
  read_url: {
    label: "Read URL",
    Icon: BookOpenTextIcon,
    tone: "text-emerald-500"
  },
  extract_data: {
    label: "Extract Data",
    Icon: DatabaseIcon,
    tone: "text-violet-500"
  },
  capture_screenshot: {
    label: "Screenshot",
    Icon: CameraIcon,
    tone: "text-amber-500"
  },
  save_finding: {
    label: "Save Finding",
    Icon: LightbulbIcon,
    tone: "text-yellow-500"
  }
};

function ToolHeader({
  name,
  state,
  rightSlot
}: {
  name: string;
  state: "running" | "done" | "rejected" | "approval";
  rightSlot?: React.ReactNode;
}) {
  const meta = RESEARCH_TOOLS[name];
  const Icon = meta?.Icon ?? WrenchIcon;
  const tone = meta?.tone ?? "text-kumo-inactive";
  return (
    <div className="flex items-center gap-2">
      <Icon size={14} className={tone} />
      <Text size="xs" variant="secondary" bold>
        {meta?.label ?? name}
      </Text>
      {state === "running" && (
        <Badge variant="secondary">
          <HourglassMediumIcon size={10} className="mr-1 animate-pulse" />
          Running
        </Badge>
      )}
      {state === "done" && (
        <Badge variant="secondary">
          <CheckIcon size={10} className="mr-1" />
          Done
        </Badge>
      )}
      {state === "rejected" && <Badge variant="secondary">Rejected</Badge>}
      {state === "approval" && (
        <Badge variant="secondary">Needs approval</Badge>
      )}
      {rightSlot}
    </div>
  );
}

function SearchResultsCard({
  output
}: {
  output: {
    query: string;
    count: number;
    error?: string;
    results: Array<{ title: string; url: string; snippet: string }>;
  };
}) {
  const [open, setOpen] = useState(false);
  if (output.error) {
    return (
      <div className="text-xs text-kumo-danger font-mono">{output.error}</div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Text size="xs" variant="secondary">
          Query: <span className="font-mono">"{output.query}"</span>
        </Text>
        <Badge variant="secondary">{output.count} results</Badge>
        {output.results.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            icon={
              <CaretDownIcon
                size={12}
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            }
          >
            {open ? "Hide" : "Show"}
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-1.5">
          {output.results.map((r, i) => (
            <a
              key={`${r.url}-${i}`}
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-2 py-1.5 rounded-md bg-kumo-control/40 hover:bg-kumo-control transition-colors"
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <GlobeIcon size={10} className="text-kumo-inactive shrink-0" />
                <span className="text-[10px] font-mono text-kumo-subtle truncate">
                  {hostFromUrl(r.url)}
                </span>
              </div>
              <div className="text-xs font-medium text-kumo-default leading-snug line-clamp-1">
                {r.title}
              </div>
              {r.snippet && (
                <div className="text-[11px] text-kumo-subtle leading-snug line-clamp-2 mt-0.5">
                  {r.snippet}
                </div>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ReadUrlCard({
  output
}: {
  output: {
    url: string;
    title?: string;
    content?: string;
    primaryImage?: { src: string; alt: string } | null;
    images?: Array<{ src: string; alt: string }>;
    error?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  if (output.error) {
    return (
      <div className="text-xs text-kumo-danger font-mono">{output.error}</div>
    );
  }
  const totalImages =
    (output.images?.length ?? 0) + (output.primaryImage ? 1 : 0);
  return (
    <div className="space-y-1.5">
      <a
        href={output.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 group"
      >
        <GlobeIcon size={11} className="text-kumo-inactive shrink-0" />
        <span className="text-xs font-medium text-kumo-default truncate">
          {output.title || output.url}
        </span>
        <ArrowSquareOutIcon
          size={10}
          className="text-kumo-inactive opacity-0 group-hover:opacity-100"
        />
      </a>
      <div className="text-[10px] font-mono text-kumo-subtle truncate">
        {hostFromUrl(output.url)}
      </div>
      {output.primaryImage?.src && (
        <a
          href={output.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <img
            src={output.primaryImage.src}
            alt={output.primaryImage.alt || ""}
            loading="lazy"
            className="max-h-40 w-full rounded-md border border-kumo-line object-cover"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        </a>
      )}
      <div className="flex flex-wrap gap-1.5">
        {output.content && (
          <Badge variant="secondary">{output.content.length} chars</Badge>
        )}
        {totalImages > 0 && (
          <Badge variant="secondary">
            <ImageIcon size={10} className="mr-1" />
            {totalImages} image{totalImages === 1 ? "" : "s"}
          </Badge>
        )}
        {output.content && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
            icon={
              <CaretDownIcon
                size={12}
                className={`transition-transform ${open ? "rotate-180" : ""}`}
              />
            }
          >
            {open ? "Hide content" : "Show content"}
          </Button>
        )}
      </div>
      {open && output.content && (
        <pre className="mt-1 px-2 py-2 rounded-md bg-kumo-control/40 text-[11px] text-kumo-default whitespace-pre-wrap leading-snug max-h-64 overflow-auto">
          {output.content.slice(0, 4000)}
          {output.content.length > 4000 && "\n\n[…truncated for display]"}
        </pre>
      )}
    </div>
  );
}

function ExtractDataCard({
  output
}: {
  output: {
    url: string;
    title?: string;
    instruction?: string;
    data?: unknown;
    error?: string;
  };
}) {
  const [open, setOpen] = useState(false);
  if (output.error) {
    return (
      <div className="text-xs text-kumo-danger font-mono">{output.error}</div>
    );
  }
  const itemCount =
    output.data &&
    typeof output.data === "object" &&
    Array.isArray((output.data as { items?: unknown[] }).items)
      ? (output.data as { items: unknown[] }).items.length
      : null;
  return (
    <div className="space-y-1.5">
      <a
        href={output.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5"
      >
        <GlobeIcon size={11} className="text-kumo-inactive shrink-0" />
        <span className="text-xs font-medium text-kumo-default truncate">
          {output.title || output.url}
        </span>
      </a>
      {output.instruction && (
        <Text size="xs" variant="secondary">
          {output.instruction}
        </Text>
      )}
      <div className="flex items-center gap-1.5">
        {itemCount !== null && (
          <Badge variant="secondary">{itemCount} records</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          icon={
            <CaretDownIcon
              size={12}
              className={`transition-transform ${open ? "rotate-180" : ""}`}
            />
          }
        >
          {open ? "Hide JSON" : "Show JSON"}
        </Button>
      </div>
      {open && (
        <pre className="mt-1 px-2 py-2 rounded-md bg-kumo-control/40 text-[11px] text-kumo-default whitespace-pre-wrap leading-snug max-h-72 overflow-auto font-mono">
          {JSON.stringify(output.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ScreenshotCard({
  output
}: {
  output: {
    url: string;
    title?: string;
    caption?: string;
    dataUri?: string;
    sizeBytes?: number;
    error?: string;
  };
}) {
  if (output.error) {
    return (
      <div className="text-xs text-kumo-danger font-mono">{output.error}</div>
    );
  }
  return (
    <div className="space-y-1.5">
      <a
        href={output.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5"
      >
        <GlobeIcon size={11} className="text-kumo-inactive shrink-0" />
        <span className="text-xs font-medium text-kumo-default truncate">
          {output.title || output.url}
        </span>
      </a>
      {output.dataUri && (
        <a href={output.url} target="_blank" rel="noopener noreferrer">
          <img
            src={output.dataUri}
            alt={output.caption || "Screenshot"}
            className="max-w-full max-h-56 rounded-md border border-kumo-line object-cover"
          />
        </a>
      )}
      {output.caption && (
        <Text size="xs" variant="secondary">
          {output.caption}
        </Text>
      )}
      {output.sizeBytes && (
        <Badge variant="secondary">
          {Math.round(output.sizeBytes / 1024)} KB
        </Badge>
      )}
    </div>
  );
}

function FindingCard({
  input
}: {
  input: { text?: string; sourceUrls?: string[] };
}) {
  return (
    <div className="space-y-1">
      {input.text && (
        <div className="flex gap-1.5">
          <QuotesIcon
            size={12}
            className="text-yellow-500 shrink-0 mt-0.5"
            weight="fill"
          />
          <Text size="xs">{input.text}</Text>
        </div>
      )}
      {input.sourceUrls && input.sourceUrls.length > 0 && (
        <div className="flex flex-wrap gap-1 ml-4">
          {input.sourceUrls.map((u, i) => (
            <a
              key={`${u}-${i}`}
              href={u}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-kumo-subtle hover:text-kumo-brand truncate max-w-[200px]"
            >
              {hostFromUrl(u)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);
  const isResearchTool = toolName in RESEARCH_TOOLS;

  // Approval flow (kept for any approval-requiring tools, e.g. via MCP)
  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <ToolHeader name={toolName} state="approval" />
          <div className="font-mono mt-2 mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: true })
              }
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() =>
                approvalId &&
                addToolApprovalResponse({ id: approvalId, approved: false })
              }
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  if (
    part.state === "output-denied" ||
    ("approval" in part &&
      (part.approval as { approved?: boolean })?.approved === false)
  ) {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <ToolHeader name={toolName} state="rejected" />
        </Surface>
      </div>
    );
  }

  if (part.state === "input-available" || part.state === "input-streaming") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <ToolHeader name={toolName} state="running" />
          {isResearchTool && part.input ? (
            <div className="mt-1.5">
              <ResearchToolInput name={toolName} input={part.input} />
            </div>
          ) : null}
        </Surface>
      </div>
    );
  }

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] w-full px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <ToolHeader name={toolName} state="done" />
          <div className="mt-2">
            <ResearchToolOutput
              name={toolName}
              input={part.input}
              output={part.output}
            />
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

function ResearchToolInput({ name, input }: { name: string; input: unknown }) {
  const i = input as Record<string, unknown> | null | undefined;
  if (!i) return null;
  if (name === "web_search" && typeof i.query === "string") {
    return (
      <Text size="xs" variant="secondary" DANGEROUS_className="font-mono">
        "{i.query}"
      </Text>
    );
  }
  if (
    (name === "read_url" ||
      name === "capture_screenshot" ||
      name === "extract_data") &&
    typeof i.url === "string"
  ) {
    return (
      <Text
        size="xs"
        variant="secondary"
        DANGEROUS_className="font-mono truncate block"
      >
        {hostFromUrl(i.url)}
      </Text>
    );
  }
  if (name === "save_finding" && typeof i.text === "string") {
    return (
      <Text size="xs" variant="secondary" DANGEROUS_className="line-clamp-1">
        {i.text}
      </Text>
    );
  }
  return null;
}

function ResearchToolOutput({
  name,
  input,
  output
}: {
  name: string;
  input: unknown;
  output: unknown;
}) {
  if (name === "web_search") {
    return (
      <SearchResultsCard
        output={output as Parameters<typeof SearchResultsCard>[0]["output"]}
      />
    );
  }
  if (name === "read_url") {
    return (
      <ReadUrlCard
        output={output as Parameters<typeof ReadUrlCard>[0]["output"]}
      />
    );
  }
  if (name === "extract_data") {
    return (
      <ExtractDataCard
        output={output as Parameters<typeof ExtractDataCard>[0]["output"]}
      />
    );
  }
  if (name === "capture_screenshot") {
    return (
      <ScreenshotCard
        output={output as Parameters<typeof ScreenshotCard>[0]["output"]}
      />
    );
  }
  if (name === "save_finding") {
    return (
      <FindingCard input={input as { text?: string; sourceUrls?: string[] }} />
    );
  }
  // Fallback for MCP / unknown tools
  return (
    <pre className="text-[11px] text-kumo-subtle whitespace-pre-wrap font-mono max-h-48 overflow-auto">
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}

// ── Research sidebar ──────────────────────────────────────────────────

function ResearchSidebar({
  state,
  onReset
}: {
  state: ResearchState;
  onReset: () => void;
}) {
  const sourcesByKind = useMemo(() => {
    const m: Record<SourceKind, Source[]> = {
      "search-result": [],
      read: [],
      extract: [],
      screenshot: []
    };
    for (const s of state.sources) m[s.kind].push(s);
    return m;
  }, [state.sources]);

  // Force re-render every 30s for relative timestamps
  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(i);
  }, []);

  const hasContent =
    state.topic || state.sources.length > 0 || state.findings.length > 0;

  return (
    <aside className="w-full lg:w-80 lg:shrink-0 h-full min-h-0 border-l border-kumo-line bg-kumo-base lg:bg-transparent overflow-y-auto">
      <div className="p-4 space-y-4">
        {/* Topic */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <ListBulletsIcon size={14} className="text-kumo-inactive" />
              <Text
                size="xs"
                variant="secondary"
                bold
                DANGEROUS_className="uppercase tracking-wide"
              >
                Brief
              </Text>
            </div>
            {hasContent && (
              <Button
                variant="ghost"
                size="sm"
                shape="square"
                aria-label="Reset research"
                icon={<TrashIcon size={12} />}
                onClick={onReset}
              />
            )}
          </div>
          {state.topic ? (
            <div className="space-y-1.5">
              <Text size="sm" DANGEROUS_className="leading-snug line-clamp-4">
                {state.topic}
              </Text>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge
                  variant={
                    state.status === "researching"
                      ? "primary"
                      : state.status === "complete"
                        ? "secondary"
                        : "secondary"
                  }
                >
                  {state.status === "researching" && (
                    <CircleIcon
                      size={6}
                      weight="fill"
                      className="mr-1 animate-pulse"
                    />
                  )}
                  {state.status === "complete" && (
                    <CheckIcon size={10} className="mr-1" />
                  )}
                  {state.status}
                </Badge>
                {state.startedAt && (
                  <Text size="xs" variant="secondary">
                    started {relTime(state.startedAt)}
                  </Text>
                )}
              </div>
            </div>
          ) : (
            <Text size="xs" variant="secondary">
              Ask a research question to begin.
            </Text>
          )}
        </section>

        {/* Sources */}
        {state.sources.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <GlobeIcon size={14} className="text-sky-500" />
                <Text
                  size="xs"
                  variant="secondary"
                  bold
                  DANGEROUS_className="uppercase tracking-wide"
                >
                  Sources
                </Text>
                <Badge variant="secondary">{state.sources.length}</Badge>
              </div>
            </div>

            {/* Kind chips */}
            <div className="flex flex-wrap gap-1">
              {sourcesByKind["search-result"].length > 0 && (
                <Badge variant="secondary">
                  <MagnifyingGlassIcon size={10} className="mr-1" />
                  {sourcesByKind["search-result"].length}
                </Badge>
              )}
              {sourcesByKind.read.length > 0 && (
                <Badge variant="secondary">
                  <BookOpenTextIcon size={10} className="mr-1" />
                  {sourcesByKind.read.length}
                </Badge>
              )}
              {sourcesByKind.extract.length > 0 && (
                <Badge variant="secondary">
                  <DatabaseIcon size={10} className="mr-1" />
                  {sourcesByKind.extract.length}
                </Badge>
              )}
              {sourcesByKind.screenshot.length > 0 && (
                <Badge variant="secondary">
                  <CameraIcon size={10} className="mr-1" />
                  {sourcesByKind.screenshot.length}
                </Badge>
              )}
            </div>

            <ul className="space-y-1.5">
              {[...state.sources]
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, 30)
                .map((s) => (
                  <li
                    key={s.id}
                    className="rounded-md bg-kumo-control/40 hover:bg-kumo-control transition-colors"
                  >
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block px-2 py-1.5"
                    >
                      <div className="flex items-center gap-1 mb-0.5">
                        <GlobeIcon
                          size={9}
                          className="text-kumo-inactive shrink-0"
                        />
                        <span className="text-[10px] font-mono text-kumo-subtle truncate">
                          {hostFromUrl(s.url)}
                        </span>
                        <Badge
                          variant="secondary"
                          className="ml-auto shrink-0 text-[9px]!"
                        >
                          {s.kind === "search-result" ? "search" : s.kind}
                        </Badge>
                      </div>
                      <div className="text-xs text-kumo-default leading-snug line-clamp-2">
                        {s.title}
                      </div>
                    </a>
                  </li>
                ))}
            </ul>
          </section>
        )}

        {/* Findings */}
        {state.findings.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center gap-1.5">
              <LightbulbIcon size={14} className="text-yellow-500" />
              <Text
                size="xs"
                variant="secondary"
                bold
                DANGEROUS_className="uppercase tracking-wide"
              >
                Findings
              </Text>
              <Badge variant="secondary">{state.findings.length}</Badge>
            </div>
            <ul className="space-y-1.5">
              {[...state.findings]
                .sort((a, b) => b.timestamp - a.timestamp)
                .map((f, idx) => (
                  <li
                    key={f.id}
                    className="px-2 py-1.5 rounded-md bg-kumo-control/40"
                  >
                    <div className="flex items-start gap-1.5">
                      <span className="text-[10px] font-mono text-kumo-subtle mt-0.5 shrink-0">
                        {state.findings.length - idx}.
                      </span>
                      <div className="flex-1 min-w-0">
                        <Text size="xs" DANGEROUS_className="leading-snug">
                          {f.text}
                        </Text>
                        {f.sourceUrls.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {f.sourceUrls.map((u, i) => (
                              <a
                                key={`${u}-${i}`}
                                href={u}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] font-mono text-kumo-subtle hover:text-kumo-brand truncate max-w-[140px]"
                              >
                                {hostFromUrl(u)}
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}

// ── Main chat ─────────────────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toasts = useKumoToastManager();
  const [mcpState, setMcpState] = useState<MCPServersState>({
    prompts: [],
    resources: [],
    servers: {},
    tools: []
  });
  const [showMcpPanel, setShowMcpPanel] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [isAddingServer, setIsAddingServer] = useState(false);
  const mcpPanelRef = useRef<HTMLDivElement>(null);

  const [researchState, setResearchState] =
    useState<ResearchState>(INITIAL_STATE);

  const agent = useAgent<ResearchAgent, ResearchState>({
    agent: "ResearchAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    ),
    onStateUpdate: useCallback((state: ResearchState) => {
      setResearchState(state ?? INITIAL_STATE);
    }, []),
    onMcpUpdate: useCallback((state: MCPServersState) => {
      setMcpState(state);
    }, []),
    onMessage: useCallback(
      (message: MessageEvent) => {
        try {
          const data = JSON.parse(String(message.data));
          if (data.type === "research-event") {
            toasts.add({
              title: "Research update",
              description: data.message,
              timeout: 4000
            });
          }
        } catch {
          /* not JSON */
        }
      },
      [toasts]
    )
  });

  // Close MCP panel on outside click
  useEffect(() => {
    if (!showMcpPanel) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        mcpPanelRef.current &&
        !mcpPanelRef.current.contains(e.target as Node)
      ) {
        setShowMcpPanel(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMcpPanel]);

  const handleAddServer = async () => {
    if (!mcpName.trim() || !mcpUrl.trim()) return;
    setIsAddingServer(true);
    try {
      await agent.stub.addServer(mcpName.trim(), mcpUrl.trim());
      setMcpName("");
      setMcpUrl("");
    } catch (e) {
      console.error("Failed to add MCP server:", e);
    } finally {
      setIsAddingServer(false);
    }
  };

  const handleRemoveServer = async (serverId: string) => {
    try {
      await agent.stub.removeServer(serverId);
    } catch (e) {
      console.error("Failed to remove MCP server:", e);
    }
  };

  const serverEntries = Object.entries(mcpState.servers);
  const mcpToolCount = mcpState.tools.length;

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status
  } = useAgentChat({
    agent
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    // Scroll only the chat container — never bubble up to the document.
    const c = messageScrollRef.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  const addFiles = useCallback((files: FileList | File[]) => {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    setAttachments((prev) => [...prev, ...images.map(createAttachment)]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.id === id);
      if (att) URL.revokeObjectURL(att.preview);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles]
  );

  const send = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isStreaming) return;
    setInput("");
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mediaType: string; url: string }
    > = [];
    if (text) parts.push({ type: "text", text });
    for (const att of attachments) {
      const dataUri = await fileToDataUri(att.file);
      parts.push({ type: "file", mediaType: att.mediaType, url: dataUri });
    }
    for (const att of attachments) URL.revokeObjectURL(att.preview);
    setAttachments([]);
    sendMessage({ role: "user", parts });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, attachments, isStreaming, sendMessage]);

  const handleClearAll = useCallback(async () => {
    clearHistory();
    try {
      await agent.stub.resetResearch();
    } catch (e) {
      console.error(e);
    }
  }, [clearHistory, agent.stub]);

  return (
    <div
      className="flex flex-col h-screen overflow-hidden bg-kumo-elevated relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-kumo-elevated/80 backdrop-blur-sm border-2 border-dashed border-kumo-brand rounded-xl m-2 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-kumo-brand">
            <ImageIcon size={40} />
            <Text variant="heading3">Drop images for context</Text>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line shrink-0">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default flex items-center gap-2">
              <AtomIcon
                size={20}
                weight="duotone"
                className="text-kumo-brand"
              />
              Deep Research
            </h1>
            <Badge variant="secondary">
              <GlobeIcon size={12} weight="bold" className="mr-1" />
              browser-driven
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="hidden md:flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <div className="relative" ref={mcpPanelRef}>
              <Button
                variant="secondary"
                icon={<PlugsConnectedIcon size={16} />}
                onClick={() => setShowMcpPanel(!showMcpPanel)}
              >
                MCP
                {mcpToolCount > 0 && (
                  <Badge variant="primary" className="ml-1.5">
                    <WrenchIcon size={10} className="mr-0.5" />
                    {mcpToolCount}
                  </Badge>
                )}
              </Button>
              {showMcpPanel && (
                <div className="absolute right-0 top-full mt-2 w-96 z-50">
                  <Surface className="rounded-xl ring ring-kumo-line shadow-lg p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <PlugsConnectedIcon
                          size={16}
                          className="text-kumo-accent"
                        />
                        <Text size="sm" bold>
                          MCP Servers
                        </Text>
                        {serverEntries.length > 0 && (
                          <Badge variant="secondary">
                            {serverEntries.length}
                          </Badge>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        shape="square"
                        aria-label="Close MCP panel"
                        icon={<XIcon size={14} />}
                        onClick={() => setShowMcpPanel(false)}
                      />
                    </div>
                    <Text size="xs" variant="secondary">
                      Connect MCP servers to give the agent more research tools
                      (e.g. Wikipedia, arXiv, internal docs).
                    </Text>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        handleAddServer();
                      }}
                      className="space-y-2"
                    >
                      <input
                        type="text"
                        value={mcpName}
                        onChange={(e) => setMcpName(e.target.value)}
                        placeholder="Server name"
                        className="w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={mcpUrl}
                          onChange={(e) => setMcpUrl(e.target.value)}
                          placeholder="https://mcp.example.com"
                          className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent font-mono"
                        />
                        <Button
                          type="submit"
                          variant="primary"
                          size="sm"
                          icon={<PlusIcon size={14} />}
                          disabled={
                            isAddingServer || !mcpName.trim() || !mcpUrl.trim()
                          }
                        >
                          {isAddingServer ? "..." : "Add"}
                        </Button>
                      </div>
                    </form>
                    {serverEntries.length > 0 && (
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {serverEntries.map(([id, server]) => (
                          <div
                            key={id}
                            className="flex items-start justify-between p-2.5 rounded-lg border border-kumo-line"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-kumo-default truncate">
                                  {server.name}
                                </span>
                                <Badge
                                  variant={
                                    server.state === "ready"
                                      ? "primary"
                                      : server.state === "failed"
                                        ? "destructive"
                                        : "secondary"
                                  }
                                >
                                  {server.state}
                                </Badge>
                              </div>
                              <span className="text-xs font-mono text-kumo-subtle truncate block mt-0.5">
                                {server.server_url}
                              </span>
                              {server.state === "failed" && server.error && (
                                <span className="text-xs text-red-500 block mt-0.5">
                                  {server.error}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0 ml-2">
                              {server.state === "authenticating" &&
                                server.auth_url && (
                                  <Button
                                    variant="primary"
                                    size="sm"
                                    icon={<SignInIcon size={12} />}
                                    onClick={() =>
                                      window.open(
                                        server.auth_url as string,
                                        "oauth",
                                        "width=600,height=800"
                                      )
                                    }
                                  >
                                    Auth
                                  </Button>
                                )}
                              <Button
                                variant="ghost"
                                size="sm"
                                shape="square"
                                aria-label="Remove server"
                                icon={<TrashIcon size={12} />}
                                onClick={() => handleRemoveServer(id)}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {mcpToolCount > 0 && (
                      <div className="pt-2 border-t border-kumo-line">
                        <div className="flex items-center gap-2">
                          <WrenchIcon size={14} className="text-kumo-subtle" />
                          <span className="text-xs text-kumo-subtle">
                            {mcpToolCount} tool
                            {mcpToolCount !== 1 ? "s" : ""} available from MCP
                            servers
                          </span>
                        </div>
                      </div>
                    )}
                  </Surface>
                </div>
              )}
            </div>
            <Button
              variant="secondary"
              shape="square"
              aria-label="Toggle research sidebar"
              icon={<SidebarIcon size={16} />}
              onClick={() => setShowSidebar((v) => !v)}
              className="hidden lg:inline-flex"
            />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClearAll}
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Messages column */}
        <div ref={messageScrollRef} className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-5 py-6 space-y-4">
            {messages.length === 0 && (
              <Empty
                icon={<AtomIcon size={32} weight="duotone" />}
                title="Ask anything researchable"
                contents={
                  <div className="space-y-3">
                    <Text
                      size="sm"
                      variant="secondary"
                      DANGEROUS_className="text-center block"
                    >
                      The agent will search the web with a real headless
                      browser, read sources, extract data, capture screenshots
                      where useful, and produce a cited Markdown report.
                    </Text>
                    <div className="flex flex-wrap justify-center gap-2">
                      {TOOL_PROMPTS.map((p) => (
                        <Button
                          key={p.label}
                          variant="outline"
                          size="sm"
                          disabled={isStreaming}
                          onClick={() => {
                            sendMessage({
                              role: "user",
                              parts: [{ type: "text", text: p.query }]
                            });
                          }}
                        >
                          {p.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                }
              />
            )}

            {messages.map((message: UIMessage, index: number) => {
              const isUser = message.role === "user";
              const isLastAssistant =
                message.role === "assistant" && index === messages.length - 1;
              // Email metadata is attached server-side in onEmail() so the
              // chat UI can badge inbound-email turns. We narrow loosely
              // because UIMessage.metadata is typed as unknown by default.
              const emailMeta = (message as { metadata?: unknown }).metadata as
                | {
                    source?: string;
                    from?: string;
                    subject?: string;
                  }
                | undefined;
              const isEmailSourced =
                isUser && emailMeta?.source === "email" && !!emailMeta.from;

              return (
                <div key={message.id} className="space-y-2">
                  {showDebug && (
                    <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                      {JSON.stringify(message, null, 2)}
                    </pre>
                  )}

                  {/* Email-source badge — appears above the user bubble for
                      questions that arrived via the email interface. */}
                  {isEmailSourced && (
                    <div className="flex justify-end">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-[11px] text-blue-400">
                        <EnvelopeIcon size={12} weight="fill" />
                        <span className="font-medium">Email from</span>
                        <span className="font-mono text-kumo-default">
                          {emailMeta?.from}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Tool parts */}
                  {message.parts.filter(isToolUIPart).map((part) => (
                    <ToolPartView
                      key={part.toolCallId}
                      part={part}
                      addToolApprovalResponse={addToolApprovalResponse}
                    />
                  ))}

                  {/* Reasoning parts */}
                  {message.parts
                    .filter(
                      (part) =>
                        part.type === "reasoning" &&
                        (part as { text?: string }).text?.trim()
                    )
                    .map((part, i) => {
                      const reasoning = part as {
                        type: "reasoning";
                        text: string;
                        state?: "streaming" | "done";
                      };
                      const isDone = reasoning.state === "done" || !isStreaming;
                      return (
                        <div key={i} className="flex justify-start">
                          <details
                            className="max-w-[85%] w-full"
                            open={!isDone}
                          >
                            <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                              <LightbulbIcon
                                size={14}
                                className="text-purple-400"
                              />
                              <span className="font-medium text-kumo-default">
                                Reasoning
                              </span>
                              {isDone ? (
                                <span className="text-xs text-kumo-success">
                                  Complete
                                </span>
                              ) : (
                                <span className="text-xs text-kumo-brand">
                                  Thinking...
                                </span>
                              )}
                              <CaretDownIcon
                                size={14}
                                className="ml-auto text-kumo-inactive"
                              />
                            </summary>
                            <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                              {reasoning.text}
                            </pre>
                          </details>
                        </div>
                      );
                    })}

                  {/* Image attachments from user */}
                  {message.parts
                    .filter(
                      (part): part is Extract<typeof part, { type: "file" }> =>
                        part.type === "file" &&
                        (part as { mediaType?: string }).mediaType?.startsWith(
                          "image/"
                        ) === true
                    )
                    .map((part, i) => (
                      <div
                        key={`file-${i}`}
                        className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                      >
                        <img
                          src={part.url}
                          alt="Attachment"
                          className="max-h-64 rounded-xl border border-kumo-line object-contain"
                        />
                      </div>
                    ))}

                  {/* Text parts */}
                  {message.parts
                    .filter((part) => part.type === "text")
                    .map((part, i) => {
                      const text = (part as { type: "text"; text: string })
                        .text;
                      if (!text) return null;
                      if (isUser) {
                        return (
                          <div key={i} className="flex justify-end">
                            <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                              {text}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={i} className="flex justify-start">
                          <div className="max-w-full w-full rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed">
                            <Streamdown
                              className="sd-theme rounded-2xl rounded-bl-md p-4"
                              plugins={{ code, mermaid }}
                              controls={false}
                              isAnimating={isLastAssistant && isStreaming}
                            >
                              {text}
                            </Streamdown>
                          </div>
                        </div>
                      );
                    })}
                </div>
              );
            })}

            {researchState.lastError && !isStreaming && (
              <div className="flex justify-start">
                <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-danger">
                  <div className="flex items-start gap-2">
                    <WarningIcon
                      size={16}
                      className="text-kumo-danger shrink-0 mt-0.5"
                      weight="fill"
                    />
                    <div className="min-w-0 flex-1">
                      <Text size="xs" variant="error" bold>
                        Research run hit an error
                      </Text>
                      <pre className="mt-1 whitespace-pre-wrap text-[11px] text-kumo-default font-mono overflow-x-auto">
                        {researchState.lastError}
                      </pre>
                      <Text size="xs" variant="secondary">
                        Try rephrasing, or send the message again. The agent
                        retains its sources from this turn.
                      </Text>
                    </div>
                  </div>
                </Surface>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Sidebar */}
        {showSidebar && (
          <div className="hidden lg:flex h-full min-h-0">
            <ResearchSidebar
              state={researchState}
              onReset={() =>
                agent.stub.resetResearch().catch((e) => console.error(e))
              }
            />
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-kumo-line bg-kumo-base shrink-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {attachments.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  className="relative group rounded-lg border border-kumo-line bg-kumo-control overflow-hidden"
                >
                  <img
                    src={att.preview}
                    alt={att.file.name}
                    className="h-16 w-16 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    className="absolute top-0.5 right-0.5 rounded-full bg-kumo-contrast/80 text-kumo-inverse p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Remove ${att.file.name}`}
                  >
                    <XIcon size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <Button
              type="button"
              variant="ghost"
              shape="square"
              aria-label="Attach images"
              icon={<PaperclipIcon size={18} />}
              onClick={() => fileInputRef.current?.click()}
              disabled={!connected || isStreaming}
              className="mb-0.5"
            />
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              onPaste={handlePaste}
              placeholder={
                attachments.length > 0
                  ? "Add a message or send images..."
                  : "What should we research?"
              }
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={
                  (!input.trim() && attachments.length === 0) || !connected
                }
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
