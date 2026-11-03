// Which projects and collections the holder analysis follows, from Nexus's own tables: projects
// with holder_analysis_enabled, their collections, and each collection's analysis settings.
// A collection with no settings row gets defaults (core for ERC-721, a short id from its name).

import { chainIsOn } from '../indexing/chain-switches';
import { sql } from 'drizzle-orm';
import type { Database } from '@nexus/database';
import type { Collection, Project, Standard } from '@nexus/holder-analysis';

/** A collection as the analysis sees it, plus where it lives in Nexus. */
export type AnalysisCollection = Collection & { collectionId: string; chain: string };
export type AnalysisProject = Omit<Project, 'collections'> & { collections: AnalysisCollection[] };

type Row = {
  project_id: string;
  project_name: string;
  collection_id: string;
  collection_name: string;
  chain: string;
  contract_address: string;
  collection_type: string;
  short_id: string | null;
  standard: string | null;
  core: boolean | null;
  decimals: number | null;
  staking_contracts: string[] | null;
  token_names: Record<string, string> | null;
};

const STANDARDS: Standard[] = ['erc721', 'erc1155', 'erc20'];

/** A short id from a name: lowercase letters and digits, at most 12, unique in `taken`. */
export function shortIdFor(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'c';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 12 - String(n).length)}${n}`;
  taken.add(id);
  return id;
}

/** Turns joined rows into projects; EVM collections only (Solana analysis comes later). */
export function toProjects(rows: Row[]): AnalysisProject[] {
  const byProject = new Map<string, AnalysisProject & { taken: Set<string> }>();
  for (const r of rows) {
    if (r.chain === 'solana') continue;
    let p = byProject.get(r.project_id);
    if (!p) {
      p = { id: r.project_id, name: r.project_name, collections: [], taken: new Set() };
      byProject.set(r.project_id, p);
    }
    const standard = (STANDARDS.includes(r.standard as Standard) ? r.standard : r.collection_type) as Standard;
    if (!STANDARDS.includes(standard)) continue;
    const id = r.short_id && !p.taken.has(r.short_id) ? (p.taken.add(r.short_id), r.short_id) : shortIdFor(r.collection_name, p.taken);
    p.collections.push({
      id,
      collectionId: r.collection_id,
      chain: r.chain,
      name: r.collection_name,
      short: r.collection_name,
      contract: r.contract_address.toLowerCase(),
      standard,
      core: r.core ?? standard === 'erc721',
      decimals: standard === 'erc20' ? (r.decimals ?? 18) : 0,
      staking: standard === 'erc721' ? (r.staking_contracts ?? []).map((s) => s.toLowerCase()) : [],
      tokenNames: r.token_names ?? {},
    });
  }
  const out: AnalysisProject[] = [];
  for (const { taken: _taken, ...p } of byProject.values()) {
    if (!p.collections.length) continue;
    // A project with no core collection (say, one ERC-20) treats them all as core.
    if (!p.collections.some((c) => c.core)) for (const c of p.collections) c.core = true;
    out.push(p);
  }
  return out;
}

/** Every project with holder analysis turned on, with its EVM collections. */
export async function loadEnabledProjects(db: Database, projectId?: string): Promise<AnalysisProject[]> {
  const rows = await db.execute<Row>(sql`
    SELECT p.id AS project_id, p.name AS project_name,
           c.id AS collection_id, c.name AS collection_name, c.chain::text AS chain,
           c.contract_address, c.collection_type::text AS collection_type,
           s.short_id, s.standard, s.core, s.decimals, s.staking_contracts, s.token_names
    FROM projects p
    JOIN collections c ON c.project_id = p.id
    LEFT JOIN holder_analysis_collection_settings s ON s.collection_id = c.id
    WHERE p.holder_analysis_enabled
      -- Collections on chains an admin switched off aren't synced or analysed.
      AND ${chainIsOn(sql`c.chain`)}
      ${projectId ? sql`AND p.id = ${projectId}` : sql``}
    ORDER BY p.created_at, c.first_seen_at, c.id
  `);
  return toProjects([...rows]);
}
