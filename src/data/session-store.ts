/**
 * Bot credential and session management — Drizzle ORM version.
 */

import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { DB } from "./db";
import { botSessions } from "./schema";

export interface BotCredentials {
  username: string;
  password: string;
  empire: string | null;
  playerId: string | null;
  sessionId: string | null;
  sessionExpiresAt: string | null;
}

export class SessionStore {
  constructor(private db: DB) {}

  listBots(): BotCredentials[] {
    return this.db.select().from(botSessions).all().map((r) => ({
      username: r.username,
      password: r.password,
      empire: r.empire,
      playerId: r.playerId,
      sessionId: r.sessionId,
      sessionExpiresAt: r.sessionExpiresAt,
    }));
  }

  getBot(username: string): BotCredentials | null {
    const row = this.db.select().from(botSessions).where(eq(botSessions.username, username)).get();
    if (!row) return null;
    return {
      username: row.username,
      password: row.password,
      empire: row.empire,
      playerId: row.playerId,
      sessionId: row.sessionId,
      sessionExpiresAt: row.sessionExpiresAt,
    };
  }

  upsertBot(creds: Omit<BotCredentials, "sessionId" | "sessionExpiresAt">): void {
    this.db.insert(botSessions).values({
      username: creds.username,
      password: creds.password,
      empire: creds.empire,
      playerId: creds.playerId,
    }).onConflictDoUpdate({
      target: botSessions.username,
      set: {
        password: creds.password,
        empire: creds.empire,
        playerId: creds.playerId,
        updatedAt: sql`datetime('now')`,
      },
    }).run();
  }

  updateSession(username: string, sessionId: string, expiresAt: string): void {
    this.db.update(botSessions)
      .set({ sessionId, sessionExpiresAt: expiresAt, updatedAt: sql`datetime('now')` })
      .where(eq(botSessions.username, username))
      .run();
  }

  clearSession(username: string): void {
    this.db.update(botSessions)
      .set({ sessionId: null, sessionExpiresAt: null, updatedAt: sql`datetime('now')` })
      .where(eq(botSessions.username, username))
      .run();
  }

  removeBot(username: string): boolean {
    const result = this.db.delete(botSessions).where(eq(botSessions.username, username)).run();
    return (result as unknown as { changes: number }).changes > 0;
  }

  isSessionValid(username: string): boolean {
    const bot = this.getBot(username);
    if (!bot?.sessionId || !bot.sessionExpiresAt) return false;
    return new Date(bot.sessionExpiresAt) > new Date();
  }
}
