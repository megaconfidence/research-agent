import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentEmail, routeAgentRequest } from "agents";
import { type AgentEmail, createCatchAllEmailResolver } from "agents/email";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import puppeteer, { type Browser } from "@cloudflare/puppeteer";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type ModelMessage
} from "ai";
import PostalMime from "postal-mime";

import {
  buildAckBody,
  buildEmailAssistantMessage,
  buildEmailUserMessage,
  EMAIL_FRIENDLY_NAME,
  extractQuestion,
  extractSender,
  formatReplySubject,
  isAutoReply,
  renderMarkdownEmail
} from "./email";
import { SYSTEM_PROMPT } from "./prompt";
import { createResearchTools } from "./tools";
import {
  type Finding,
  INITIAL_STATE,
  type ResearchState,
  type Source,
  type SourceKind
} from "./types";
import { inlineDataUrls, rid } from "./utils";

export type { EmailMessageMeta } from "./types";

export class ResearchAgent extends AIChatAgent<Env, ResearchState> {
  initialState: ResearchState = INITIAL_STATE;
  maxPersistedMessages = 60;

  // In-memory browser handle, lazily launched per chat turn and reused
  // across tool calls. Lost on hibernation — relaunched on next call.
  private browser: Browser | null = null;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  // ── RPC ──

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  @callable()
  async resetResearch() {
    this.setState(INITIAL_STATE);
  }

  // ── Browser lifecycle ──

  private async getBrowser(): Promise<Browser> {
    if (this.browser) {
      try {
        if (this.browser.connected) return this.browser;
      } catch {
        /* fallthrough to relaunch */
      }
    }
    this.browser = await puppeteer.launch(this.env.BROWSER);
    return this.browser;
  }

  private async closeBrowser() {
    if (!this.browser) return;
    const b = this.browser;
    this.browser = null;
    try {
      await b.close();
    } catch {
      /* swallow */
    }
  }

  // ── State helpers ──

  private upsertSource(input: {
    url: string;
    title: string;
    snippet?: string;
    kind: SourceKind;
  }): Source {
    const existing = this.state.sources.find(
      (s) => s.url === input.url && s.kind === input.kind
    );
    if (existing) return existing;
    const source: Source = {
      id: rid(),
      timestamp: Date.now(),
      ...input
    };
    this.setState({
      ...this.state,
      sources: [...this.state.sources, source]
    });
    return source;
  }

  private addFinding(text: string, sourceUrls: string[]): Finding {
    const finding: Finding = {
      id: rid(),
      text,
      sourceUrls,
      timestamp: Date.now()
    };
    this.setState({
      ...this.state,
      findings: [...this.state.findings, finding]
    });
    return finding;
  }

  private maybeCaptureTopic() {
    const firstUser = this.messages.find((m) => m.role === "user");
    if (!firstUser) return;
    const parts = (
      firstUser as { parts?: Array<{ type: string; text?: string }> }
    ).parts;
    const text = parts?.find((p) => p.type === "text")?.text;
    if (!text) return;
    if (this.state.topic && this.state.status === "researching") return;
    this.setState({
      ...this.state,
      topic: this.state.topic ?? text.slice(0, 240),
      status: "researching",
      lastError: null,
      startedAt: this.state.startedAt ?? Date.now()
    });
  }

  // ── Chat handler ──

  /**
   * Build the streamText config shared between chat (streaming) and email
   * (collected). Both run the same model, system prompt, and tool set so a
   * report doesn't differ depending on entry point.
   */
  private buildResearchStream(args: {
    messages: ModelMessage[];
    abortSignal?: AbortSignal;
    onFinish?: () => Promise<void> | void;
    onError?: (error: unknown) => Promise<void> | void;
  }) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });
    const researchTools = createResearchTools({
      getBrowser: () => this.getBrowser(),
      upsertSource: (input) => this.upsertSource(input),
      addFinding: (text, urls) => this.addFinding(text, urls),
      getFindingsCount: () => this.state.findings.length,
      env: this.env
    });

    return streamText({
      // GLM-4.7-Flash from Zhipu AI — fast, cheap, 131k context, with strong
      // multi-turn tool calling and instruction-following across 100+ languages.
      // Swap to "@cf/openai/gpt-oss-120b" (heavier reasoning) or
      // "@cf/moonshotai/kimi-k2.6" (262k context, vision) for different tradeoffs.
      model: workersai("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),
      system: SYSTEM_PROMPT,
      messages: args.messages,
      tools: { ...mcpTools, ...researchTools },
      stopWhen: stepCountIs(20),
      abortSignal: args.abortSignal,
      onFinish: async () => {
        this.setState({ ...this.state, status: "complete", lastError: null });
        await this.closeBrowser();
        await args.onFinish?.();
      },
      onError: async ({ error }) => {
        console.error("[ResearchAgent] streamText error:", error);
        const message =
          error instanceof Error ? error.message : String(error ?? "unknown");
        this.setState({
          ...this.state,
          status: "complete",
          lastError: message
        });
        await this.closeBrowser();
        await args.onError?.(error);
      }
    });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    this.maybeCaptureTopic();

    const result = this.buildResearchStream({
      messages: pruneMessages({
        messages: inlineDataUrls(await convertToModelMessages(this.messages)),
        toolCalls: "before-last-2-messages"
      }),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  // ── Email handler ──

  /**
   * Handle inbound research-request emails. Acknowledges the sender, runs
   * the same research pipeline as the chat UI, and emails back the rendered
   * HTML report. Each email is a fresh research turn (no chat history leak
   * between users), but messages are persisted so connected chat UIs see
   * email-driven research happen live with a 📧 badge.
   *
   * Cloudflare's `EmailMessage.reply()` can only be called ONCE per inbound
   * message, so we use it for the immediate ack and switch to `sendEmail()`
   * (via the `send_email` binding) for the final report — threaded under
   * the same conversation via `inReplyTo`.
   */
  async onEmail(email: AgentEmail) {
    const parsed = await PostalMime.parse(await email.getRaw());

    if (isAutoReply(parsed)) {
      console.log(`[ResearchAgent] skip auto-reply from ${email.from}`);
      return;
    }

    const question = extractQuestion(parsed);
    const sender = extractSender(parsed, email.from);
    if (!question) {
      email.setReject("Empty research request — include a subject or body.");
      return;
    }
    if (!sender) {
      email.setReject("Could not determine reply address.");
      return;
    }

    const subject = (parsed.subject ?? "").trim();
    const replySubject = formatReplySubject(subject);
    const inReplyTo = parsed.messageId;
    console.log(
      `[ResearchAgent] inbound from ${sender}: "${subject || "(no subject)"}"`
    );

    // Ack the sender. If even this fails (e.g. unverified sender), bail
    // before running expensive research nobody will receive.
    try {
      await this.replyToEmail(email, {
        fromName: EMAIL_FRIENDLY_NAME,
        contentType: "text/plain",
        body: buildAckBody(subject, question)
      });
    } catch (err) {
      console.error("[ResearchAgent] ack failed:", err);
      return;
    }

    // Reflect the email turn in the live chat UI + research sidebar.
    await this.persistMessages([
      ...this.messages,
      buildEmailUserMessage(question, sender, subject)
    ]);
    this.setState({
      ...this.state,
      topic: subject || question.slice(0, 240),
      status: "researching",
      lastError: null,
      startedAt: Date.now()
    });

    // Run research; reply with the rendered HTML report on success, or a
    // plaintext error otherwise.
    let report: string;
    try {
      report = await this.buildResearchStream({
        messages: [{ role: "user", content: question }]
      }).text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[ResearchAgent] research failed:", err);
      await this.sendReport({
        to: sender,
        subject: replySubject,
        inReplyTo,
        text: `Sorry — research failed:\n\n${message}\n\nPlease try again.`
      });
      return;
    }

    await this.persistMessages([
      ...this.messages,
      buildEmailAssistantMessage(report)
    ]);
    await this.sendReport({
      to: sender,
      subject: replySubject,
      inReplyTo,
      html: renderMarkdownEmail(report)
    });
  }

  /**
   * Send mail through the `send_email` binding with our default From and
   * Reply-To, logging success/failure. Used for follow-up messages — the
   * initial ack still goes via `replyToEmail` (the once-per-message slot).
   */
  private async sendReport(opts: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
  }) {
    try {
      const result = await this.sendEmail({
        binding: this.env.EMAIL,
        to: opts.to,
        from: { email: this.env.EMAIL_FROM, name: EMAIL_FRIENDLY_NAME },
        replyTo: this.env.EMAIL_FROM,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
        inReplyTo: opts.inReplyTo
      });
      console.log(
        `[ResearchAgent] sent report to ${opts.to} messageId=${result?.messageId ?? "?"}`
      );
    } catch (err) {
      console.error(`[ResearchAgent] sendEmail to ${opts.to} failed:`, err);
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  /**
   * Route every inbound email — regardless of recipient address — to the
   * single `default` instance of `ResearchAgent`, the same instance the
   * chat UI connects to. One Durable Object handles both entry points and
   * shares state between them. See README "Email interface" for setup.
   */
  async email(message, env, _ctx) {
    await routeAgentEmail(message, env, {
      resolver: createCatchAllEmailResolver("ResearchAgent", "default"),
      onNoRoute: (msg) => {
        console.warn(`[email] no route for ${msg.from} → ${msg.to}`);
        msg.setReject("No research agent configured for this address");
      }
    });
  }
} satisfies ExportedHandler<Env>;
