import { type SQL, sql } from 'drizzle-orm';
import type { Database } from '@nexus/database';

/**
 * Chains an admin switched off (chain_settings.enabled = false). Background work skips them:
 * scheduled refreshes, the holder backlog, discovery and holder analysis. Admin actions on
 * one collection still run.
 */
export async function disabledChains(db: Database): Promise<Set<string>> {
  const rows = await db.execute<{ chain: string }>(sql`SELECT chain::text AS chain FROM chain_settings WHERE NOT enabled`);
  return new Set([...rows].map((r) => r.chain));
}

/** SQL condition: the chain in `column` is switched on. */
export const chainIsOn = (column: SQL) => sql`${column} NOT IN (SELECT cs.chain FROM chain_settings cs WHERE NOT cs.enabled)`;
