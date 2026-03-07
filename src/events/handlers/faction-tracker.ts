/**
 * Faction Transaction Tracker — logs deposit/withdraw events to faction_transactions table.
 */

import type { EventBus } from "../bus";
import type { DB } from "../../data/db";
import { factionTransactions } from "../../data/schema";

export function registerFactionTracker(bus: EventBus, db: DB): void {
  bus.on("deposit", (event) => {
    if (event.target !== "faction") return;
    db.insert(factionTransactions).values({
      timestamp: Date.now(),
      botId: event.botId,
      type: "item_deposit",
      itemId: event.itemId,
      itemName: event.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      quantity: event.quantity,
    }).run();
  });

  bus.on("withdraw", (event) => {
    if (event.source !== "faction") return;
    db.insert(factionTransactions).values({
      timestamp: Date.now(),
      botId: event.botId,
      type: "item_withdraw",
      itemId: event.itemId,
      itemName: event.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      quantity: event.quantity,
    }).run();
  });

  // Track trade events involving faction (sell orders from faction storage)
  bus.on("trade_sell", (event) => {
    db.insert(factionTransactions).values({
      timestamp: Date.now(),
      botId: event.botId,
      type: "sell_order",
      itemId: event.itemId,
      itemName: event.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
      quantity: event.quantity,
      credits: event.total,
    }).run();
  });
}
