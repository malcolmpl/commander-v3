/**
 * Chat Intelligence — reads global/faction chat, extracts trade offers,
 * market intel, and player activity. Generates contextual replies.
 * Stores learned facts in MemoryStore for commander decision-making.
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

  constructor(
    private memoryStore: MemoryStore | undefined,
    ownBotNames: string[],
  ) {
    this.ownBotNames = new Set(ownBotNames.map(n => n.toLowerCase()));
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

      const content = msg.content.trim().toLowerCase();

      // Only respond to trade-relevant messages

      // 1. Someone looking to buy something we might sell
      if (BUY_REGEX.test(content) && ITEM_PATTERNS.some(p => content.includes(p))) {
        const item = ITEM_PATTERNS.find(p => content.includes(p));
        if (item) {
          const reply = this.generateTradeReply(msg.username, item, "buying");
          if (reply) {
            this.replyQueue.push({ channel, content: reply });
          }
        }
        continue;
      }

      // 2. Someone selling something we might need
      if (SELL_REGEX.test(content) && ITEM_PATTERNS.some(p => content.includes(p))) {
        const item = ITEM_PATTERNS.find(p => content.includes(p));
        if (item && (item.includes("ore") || item.includes("fuel") || item.includes("crystal"))) {
          this.replyQueue.push({
            channel,
            content: `Interested in ${item}. What's your price and quantity?`,
          });
        }
        continue;
      }

      // 3. Pirate/danger warnings — acknowledge and relay
      if (WARNING_REGEX.test(content)) {
        const location = content.match(LOCATION_REGEX)?.[1]?.trim();
        if (location) {
          this.replyQueue.push({
            channel,
            content: `Thanks for the warning about ${location}. We'll steer clear.`,
          });
        }
        continue;
      }

      // 4. Someone asking where to find ore/resources — share if we know
      if (QUESTION_REGEX.test(content) && ITEM_PATTERNS.some(p => content.includes(p))) {
        const item = ITEM_PATTERNS.find(p => content.includes(p));
        if (item) {
          // Check memory for location intel
          const locationFact = this.memoryStore?.getAll().find(
            m => m.fact.toLowerCase().includes(item) && m.fact.toLowerCase().includes("at ")
          );
          if (locationFact) {
            this.replyQueue.push({
              channel,
              content: `${msg.username}, from our intel: ${locationFact.fact}`,
            });
          }
        }
      }
    }

    // Limit queue size
    if (this.replyQueue.length > 3) {
      this.replyQueue = this.replyQueue.slice(-3);
    }
  }

  private generateTradeReply(buyer: string, item: string, _direction: "buying" | "selling"): string | null {
    // Check if we have this item in recent intel or memory
    const relevantIntel = this.recentIntel.find(
      i => i.type === "trade_offer" && i.item === item && i.direction === "selling"
    );

    if (relevantIntel && relevantIntel.source !== buyer) {
      return `${buyer}, saw ${relevantIntel.source} selling ${item} recently. Might want to check with them.`;
    }

    // Only respond if we actually trade this item
    return `We might have ${item} available. Check our sell orders at station.`;
  }
}
