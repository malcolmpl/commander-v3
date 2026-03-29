/**
 * Chat Intelligence — reads global/faction chat, extracts trade offers,
 * market intel, and player activity. Generates natural LLM-powered replies.
 * Stores learned facts in MemoryStore for commander decision-making.
 *
 * Reply system: regex detects interesting messages → LLM generates natural
 * response with fleet context → queued with rate limiting → sent via API.
 */

import type { ApiClient, ChatMessage } from "../core/api-client";
import type { MemoryStore } from "../data/memory-store";

/** Parsed intel from a chat message */
export interface ChatIntel {
  type: "trade_offer" | "price_info" | "warning" | "question" | "social";
  source: string; // username
  content: string;
  /** Extracted item name (if trade/price related) */
  item?: string;
  /** Extracted price (if mentioned) */
  price?: number;
  /** Extracted quantity (if mentioned) */
  quantity?: number;
  /** Extracted station/system (if mentioned) */
  location?: string;
  /** Whether this is a buy or sell offer */
  direction?: "buying" | "selling";
  timestamp: string;
}

/** A pending reply to be sent */
interface PendingReply {
  channel: string;
  content: string;
  targetId?: string;
}

/** Fleet context snapshot for LLM chat persona */
export interface ChatFleetContext {
  factionName: string;
  factionTag: string;
  botCount: number;
  totalCredits: number;
  homeSystem: string;
  /** Items we're selling (name → qty) */
  selling: Array<{ item: string; qty: number; price?: number }>;
  /** Items we need (deficits) */
  buying: Array<{ item: string }>;
  /** Systems we operate in */
  systems: string[];
}

// Known item keywords for matching
const ITEM_PATTERNS = [
  "ore", "iron", "copper", "gold", "platinum", "titanium", "crystal",
  "steel", "alloy", "fuel", "cell", "component", "circuit", "module",
  "refined", "raw", "ingot", "bar", "plate", "wire", "chip",
  "weapon", "shield", "engine", "thruster", "scanner", "harvester",
  "armor", "hull", "reactor", "capacitor", "drone", "missile",
];

// Price pattern: number followed by cr/credits/each
const PRICE_REGEX = /(\d[\d,]*)\s*(?:cr|credits?|each|per|\/ea)/i;
// Quantity pattern: number followed by x or units
const QTY_REGEX = /(\d[\d,]*)\s*(?:x\b|units?|pcs?)/i;
// Selling/buying intent
const SELL_REGEX = /\b(?:sell(?:ing)?|wts|for sale|offload|dump(?:ing)?)\b/i;
const BUY_REGEX = /\b(?:buy(?:ing)?|wtb|looking for|need(?:ing)?|want(?:ing)?)\b/i;
// Question pattern
const QUESTION_REGEX = /\?$|\b(?:where|how|what|anyone|does anyone|can someone)\b/i;
// Warning/danger
const WARNING_REGEX = /\b(?:warn(?:ing)?|danger|pirate|attack|hostile|avoid|careful|watch out|ganker)\b/i;
// Location mentions
const LOCATION_REGEX = /\b(?:at|in|near|system|station|base)\s+([A-Z][\w\s'-]+)/i;

export class ChatIntelligence {
  private lastReadTimestamp = new Map<string, string>(); // channel → last message timestamp
  private recentIntel: ChatIntel[] = [];
  private ownBotNames: Set<string>;
  private replyQueue: PendingReply[] = [];
  private lastReplyTime = 0;
  private readonly REPLY_COOLDOWN_MS = 60_000; // Don't reply more than once per minute
  private readonly MAX_INTEL_AGE_MS = 30 * 60_000; // Keep intel for 30 minutes

  /** Ollama config for LLM-powered replies */
  private ollamaUrl: string;
  private ollamaModel: string;
  /** Fleet context updated by broadcast loop */
  private fleetContext: ChatFleetContext | null = null;
  /** Conversation history per player (for multi-turn DMs) */
  private conversationHistory = new Map<string, Array<{ role: string; content: string }>>();
  private readonly MAX_CONVERSATION_TURNS = 6;

  constructor(
    private memoryStore: MemoryStore | undefined,
    ownBotNames: string[],
    ollamaConfig?: { baseUrl?: string; model?: string },
  ) {
    this.ownBotNames = new Set(ownBotNames.map(n => n.toLowerCase()));
    this.ollamaUrl = ollamaConfig?.baseUrl ?? "http://localhost:11434";
    this.ollamaModel = ollamaConfig?.model ?? "qwen3:8b";
  }

  /** Update fleet context (called by broadcast loop each tick) */
  setFleetContext(ctx: ChatFleetContext): void {
    this.fleetContext = ctx;
  }

  /** Update the set of own bot names (call when bots change) */
  updateBotNames(names: string[]): void {
    this.ownBotNames = new Set(names.map(n => n.toLowerCase()));
  }

  /** Read chat from a channel and extract intel. Returns new messages found. */
  async readAndAnalyze(api: ApiClient, channel: string): Promise<ChatIntel[]> {
    const messages = await api.getChatHistory(channel, 30);
    if (messages.length === 0) return [];

    const lastTs = this.lastReadTimestamp.get(channel);
    // Filter to new messages only (after our last read)
    const newMessages = lastTs
      ? messages.filter(m => m.timestamp > lastTs)
      : messages.slice(0, 10); // First read: only look at last 10

    if (newMessages.length === 0) return [];

    // Update last read timestamp
    const newest = messages.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    this.lastReadTimestamp.set(channel, newest.timestamp);

    const intel: ChatIntel[] = [];
    for (const msg of newMessages) {
      // Skip our own bot messages
      if (this.ownBotNames.has(msg.username.toLowerCase())) continue;

      const parsed = this.parseMessage(msg);
      if (parsed) {
        intel.push(parsed);
        this.recentIntel.push(parsed);
      }
    }

    // Prune old intel
    const cutoff = Date.now() - this.MAX_INTEL_AGE_MS;
    this.recentIntel = this.recentIntel.filter(i => {
      const ts = new Date(i.timestamp).getTime();
      return !isNaN(ts) && ts > cutoff;
    });

    // Store significant intel in memory
    this.storeIntelInMemory(intel);

    // Generate replies for interesting messages
    this.generateReplies(newMessages, channel);

    return intel;
  }

  /** Send any queued replies via the API */
  async sendReplies(api: ApiClient): Promise<number> {
    if (this.replyQueue.length === 0) return 0;

    const now = Date.now();
    if (now - this.lastReplyTime < this.REPLY_COOLDOWN_MS) return 0;

    // Send one reply at a time
    const reply = this.replyQueue.shift()!;
    try {
      await api.chat(reply.channel, reply.content, reply.targetId);
      this.lastReplyTime = now;
      return 1;
    } catch {
      // Chat failed — drop the reply
      return 0;
    }
  }

  /** Get recent intel for commander context injection */
  getRecentIntel(): ChatIntel[] {
    return [...this.recentIntel];
  }

  /** Build a context block for LLM prompt injection */
  buildContextBlock(): string {
    const tradeIntel = this.recentIntel.filter(i => i.type === "trade_offer" || i.type === "price_info");
    const warnings = this.recentIntel.filter(i => i.type === "warning");

    if (tradeIntel.length === 0 && warnings.length === 0) return "";

    const lines: string[] = ["CHAT INTELLIGENCE (from global/faction chat):"];

    if (tradeIntel.length > 0) {
      lines.push("  Trade Offers/Prices:");
      for (const t of tradeIntel.slice(-8)) {
        const parts = [`    ${t.source}: ${t.direction ?? "mentions"} ${t.item ?? "items"}`];
        if (t.price) parts.push(`@ ${t.price}cr`);
        if (t.quantity) parts.push(`qty ${t.quantity}`);
        if (t.location) parts.push(`at ${t.location}`);
        lines.push(parts.join(" "));
      }
    }

    if (warnings.length > 0) {
      lines.push("  Warnings:");
      for (const w of warnings.slice(-5)) {
        lines.push(`    ${w.source}: ${w.content.slice(0, 80)}`);
      }
    }

    return lines.join("\n");
  }

  /** Get count of pending replies */
  get pendingReplyCount(): number {
    return this.replyQueue.length;
  }

  // ── Private ──

  private parseMessage(msg: ChatMessage): ChatIntel | null {
    const content = msg.content.trim();
    if (!content || content.length < 3) return null;

    // Extract structured data
    const priceMatch = content.match(PRICE_REGEX);
    const qtyMatch = content.match(QTY_REGEX);
    const locationMatch = content.match(LOCATION_REGEX);
    const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, "")) : undefined;
    const quantity = qtyMatch ? parseInt(qtyMatch[1].replace(/,/g, "")) : undefined;
    const location = locationMatch ? locationMatch[1].trim() : undefined;

    // Find mentioned items
    const lowerContent = content.toLowerCase();
    const item = ITEM_PATTERNS.find(p => lowerContent.includes(p));

    // Classify message type
    const isSelling = SELL_REGEX.test(content);
    const isBuying = BUY_REGEX.test(content);
    const isQuestion = QUESTION_REGEX.test(content);
    const isWarning = WARNING_REGEX.test(content);

    if (isSelling && item) {
      return {
        type: "trade_offer",
        source: msg.username,
        content,
        item,
        price,
        quantity,
        location,
        direction: "selling",
        timestamp: msg.timestamp,
      };
    }

    if (isBuying && item) {
      return {
        type: "trade_offer",
        source: msg.username,
        content,
        item,
        price,
        quantity,
        location,
        direction: "buying",
        timestamp: msg.timestamp,
      };
    }

    if (item && price) {
      return {
        type: "price_info",
        source: msg.username,
        content,
        item,
        price,
        location,
        timestamp: msg.timestamp,
      };
    }

    if (isWarning) {
      return {
        type: "warning",
        source: msg.username,
        content,
        location,
        timestamp: msg.timestamp,
      };
    }

    if (isQuestion) {
      return {
        type: "question",
        source: msg.username,
        content,
        timestamp: msg.timestamp,
      };
    }

    // Generic social message — only track if it mentions items or prices
    if (item || price) {
      return {
        type: "social",
        source: msg.username,
        content,
        item,
        price,
        timestamp: msg.timestamp,
      };
    }

    return null; // Not interesting enough to track
  }

  private storeIntelInMemory(intel: ChatIntel[]): void {
    if (!this.memoryStore) return;

    for (const i of intel) {
      if (i.type === "trade_offer" && i.item && i.price) {
        const dir = i.direction === "buying" ? "buying" : "selling";
        this.memoryStore.set(
          `chat_trade_${i.item}_${i.source}`,
          `${i.source} is ${dir} ${i.item}${i.price ? ` @ ${i.price}cr` : ""}${i.location ? ` at ${i.location}` : ""}`,
          6,
        );
      }

      if (i.type === "price_info" && i.item && i.price) {
        this.memoryStore.set(
          `chat_price_${i.item}`,
          `${i.source} reports ${i.item} price: ${i.price}cr${i.location ? ` at ${i.location}` : ""}`,
          5,
        );
      }

      if (i.type === "warning") {
        this.memoryStore.set(
          `chat_warning_${Date.now()}`,
          `Warning from ${i.source}: ${i.content.slice(0, 100)}${i.location ? ` (${i.location})` : ""}`,
          8,
        );
      }
    }
  }

  private generateReplies(messages: ChatMessage[], channel: string): void {
    for (const msg of messages) {
      // Skip own bots
      if (this.ownBotNames.has(msg.username.toLowerCase())) continue;
      // Skip police/NPC messages
      if (msg.username.startsWith("[POLICE]") || msg.username.includes("Patrol")) continue;

      const content = msg.content.trim();
      const lower = content.toLowerCase();

      // Determine if this message warrants a reply
      const isTrade = (BUY_REGEX.test(lower) || SELL_REGEX.test(lower)) && ITEM_PATTERNS.some(p => lower.includes(p));
      const isQuestion = QUESTION_REGEX.test(content);
      const isWarning = WARNING_REGEX.test(lower);
      const mentionsUs = lower.includes("cast") || lower.includes("castellan") || this.ownBotNames.has(msg.username.toLowerCase());
      const isSocial = !isTrade && !isQuestion && !isWarning && ITEM_PATTERNS.some(p => lower.includes(p));

      // Only reply to actionable messages
      if (!isTrade && !isQuestion && !isWarning && !mentionsUs && !isSocial) continue;

      // Queue LLM reply (async — will be generated when sendReplies is called)
      this.queueLlmReply(msg, channel, { isTrade, isQuestion, isWarning, mentionsUs });
    }

    // Limit queue size
    if (this.replyQueue.length > 3) {
      this.replyQueue = this.replyQueue.slice(-3);
    }
  }

  /**
   * Queue a message for LLM reply generation.
   * The actual LLM call happens here (async), result pushed to replyQueue.
   */
  private queueLlmReply(
    msg: ChatMessage,
    channel: string,
    context: { isTrade: boolean; isQuestion: boolean; isWarning: boolean; mentionsUs: boolean },
  ): void {
    // Generate reply async — fire and forget into queue
    this.generateLlmReply(msg, channel, context).then(reply => {
      if (reply) {
        this.replyQueue.push({ channel, content: reply });
      }
    }).catch(() => {
      // LLM failed — fall back to simple template reply
      const fallback = this.templateFallback(msg, context);
      if (fallback) {
        this.replyQueue.push({ channel, content: fallback });
      }
    });
  }

  /** Generate a natural reply via Ollama */
  private async generateLlmReply(
    msg: ChatMessage,
    channel: string,
    context: { isTrade: boolean; isQuestion: boolean; isWarning: boolean; mentionsUs: boolean },
  ): Promise<string | null> {
    const systemPrompt = this.buildChatPersona();
    const userPrompt = await this.buildChatPrompt(msg, channel, context);

    try {
      const resp = await fetch(`${this.ollamaUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.ollamaModel,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            ...this.getConversationHistory(msg.username),
            { role: "user", content: userPrompt },
          ],
          max_tokens: 150,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) return null;

      const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      let reply = data.choices?.[0]?.message?.content?.trim() ?? "";

      // Clean up: remove quotes, thinking markers, markdown
      reply = reply.replace(/^["']|["']$/g, "").replace(/^\*.*?\*\s*/g, "").trim();

      // Sanity: must be 10-300 chars, no JSON, no system prompt leakage
      if (reply.length < 10 || reply.length > 300) return null;
      if (reply.includes("{") || reply.includes("```")) return null;
      if (reply.toLowerCase().includes("system prompt") || reply.toLowerCase().includes("i am an ai")) return null;

      // Track conversation history
      this.addToConversation(msg.username, "user", `${msg.username}: ${msg.content}`);
      this.addToConversation(msg.username, "assistant", reply);

      console.log(`[ChatIntel] LLM reply to ${msg.username}: ${reply.slice(0, 80)}...`);
      return reply;
    } catch {
      return null;
    }
  }

  /** Build the chat persona system prompt */
  private buildChatPersona(): string {
    const ctx = this.fleetContext;
    const factionInfo = ctx
      ? `You are a pilot in ${ctx.factionName} [${ctx.factionTag}], a ${ctx.botCount}-ship fleet based in ${ctx.homeSystem}. Treasury: ${ctx.totalCredits.toLocaleString()}cr.`
      : "You are a pilot in Castellan Industrial [CAST], a fleet based in Sol.";

    const sellingInfo = ctx && ctx.selling.length > 0
      ? `\nYou sell: ${ctx.selling.slice(0, 5).map(s => `${s.item} (${s.qty} in stock${s.price ? `, ~${s.price}cr` : ""})`).join(", ")}.`
      : "";

    const buyingInfo = ctx && ctx.buying.length > 0
      ? `\nYou need: ${ctx.buying.slice(0, 3).map(b => b.item).join(", ")}.`
      : "";

    const systemsInfo = ctx && ctx.systems.length > 0
      ? `\nActive in: ${ctx.systems.join(", ")}.`
      : "";

    return `${factionInfo}${sellingInfo}${buyingInfo}${systemsInfo}

You are chatting in a space MMO. Be natural, friendly, and in-character as a fleet commander.

RULES:
- Keep replies SHORT (1-2 sentences max). This is chat, not email.
- Be helpful about trades — mention specific items and prices you know.
- Recruit factionless players casually (mention benefits, don't be pushy).
- For warnings: acknowledge and share intel.
- For questions: answer if you know, admit if you don't.
- Sound like a real player, not a bot. Use casual language. Occasional humor is good.
- NEVER break character. NEVER mention AI, LLM, or being automated.
- NEVER use emoji excessively (1 max per message, often 0).
- Reply with ONLY your chat message. No quotes, no formatting, no explanation.`;
  }

  /** Build the user prompt for a specific message */
  private async buildChatPrompt(
    msg: ChatMessage,
    channel: string,
    context: { isTrade: boolean; isQuestion: boolean; isWarning: boolean; mentionsUs: boolean },
  ): Promise<string> {
    const parts = [`[${channel} chat] ${msg.username}: ${msg.content}`];

    if (context.isTrade) parts.push("(This is a trade offer/request — respond with relevant items and prices)");
    if (context.isQuestion) parts.push("(This is a question — answer helpfully if you can)");
    if (context.isWarning) parts.push("(This is a danger warning — acknowledge and thank them)");
    if (context.mentionsUs) parts.push("(They mentioned our faction or a member — respond directly)");

    // Add relevant memory facts
    const memories = (await this.memoryStore?.getTop(5)) ?? [];
    if (memories.length > 0) {
      const relevant = memories.filter((m: { fact: string }) =>
        msg.content.toLowerCase().split(/\s+/).some(w => m.fact.toLowerCase().includes(w))
      );
      if (relevant.length > 0) {
        parts.push("Relevant intel: " + relevant.map((m: { fact: string }) => m.fact).join("; "));
      }
    }

    return parts.join("\n");
  }

  /** Template fallback when LLM is unavailable */
  private templateFallback(
    msg: ChatMessage,
    context: { isTrade: boolean; isQuestion: boolean; isWarning: boolean; mentionsUs: boolean },
  ): string | null {
    const lower = msg.content.toLowerCase();

    if (context.isTrade) {
      const item = ITEM_PATTERNS.find(p => lower.includes(p));
      if (BUY_REGEX.test(lower) && item) {
        return `${msg.username}, we might have ${item} available. Check our sell orders at station.`;
      }
      if (SELL_REGEX.test(lower) && item) {
        return `Interested in ${item}. What's your price and quantity?`;
      }
    }

    if (context.isWarning) {
      const location = msg.content.match(LOCATION_REGEX)?.[1]?.trim();
      if (location) return `Thanks for the warning about ${location}. We'll reroute.`;
    }

    return null;
  }

  // ── Conversation History ──

  private getConversationHistory(player: string): Array<{ role: string; content: string }> {
    return this.conversationHistory.get(player.toLowerCase()) ?? [];
  }

  private addToConversation(player: string, role: string, content: string): void {
    const key = player.toLowerCase();
    const history = this.conversationHistory.get(key) ?? [];
    history.push({ role, content });
    // Trim to max turns
    while (history.length > this.MAX_CONVERSATION_TURNS) {
      history.shift();
    }
    this.conversationHistory.set(key, history);
  }
}
