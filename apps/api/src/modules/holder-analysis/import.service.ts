import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  type Database,
  collections,
  holderWalletLabels,
  holderWalletUnlinks,
  projects,
} from '@nexus/database';
import { DATABASE_TOKEN } from '../../common/database/database.module';
import { HolderAnalysisAdminService } from './holder-analysis-admin.service';

/**
 * Brings what people entered in the old holder analysis app (the spooky-bar Worker's D1) into a
 * Nexus project: each collection's settings, wallet labels and notes, and "not the same person"
 * marks. Chain data isn't carried over: Nexus reads it again.
 *
 * The rows are D1's own (`wrangler d1 execute ... --json`): `project` rows ({id, name, collections}),
 * `wallet_note` rows ({wallet, label, note, at}) and `unlink` rows ({a, b, at}), `at` in ms.
 * Safe to send again, and in parts: what Nexus already has (labels, unlinks, collections whose
 * settings were saved) is kept, never overwritten.
 */
export type ImportInput = { projects?: unknown; notes?: unknown; unlinks?: unknown };

const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_ROWS = 2000;
const SHORT_ID = /^[a-z0-9]{1,16}$/;

type OldCollection = {
  id?: unknown;
  contract?: unknown;
  standard?: unknown;
  core?: unknown;
  decimals?: unknown;
  staking?: unknown;
  tokenNames?: unknown;
};

const rows = (v: unknown, what: string): Record<string, unknown>[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((r) => !r || typeof r !== 'object'))
    throw new BadRequestException(`${what} must be a list of rows`);
  if (v.length > MAX_ROWS)
    throw new BadRequestException(`Send at most ${MAX_ROWS} ${what} at a time`);
  return v as Record<string, unknown>[];
};
const when = (at: unknown) => {
  const n = Number(at);
  return Number.isFinite(n) && n > 0 ? new Date(n) : new Date();
};

@Injectable()
export class HolderAnalysisImportService {
  constructor(
    @Inject(DATABASE_TOKEN) private readonly db: Database,
    private readonly admin: HolderAnalysisAdminService,
  ) {}

  async import(projectId: string, userId: string, input: ImportInput) {
    const project = await this.db.query.projects.findFirst({
      columns: { id: true },
      where: eq(projects.id, projectId),
    });
    if (!project) throw new NotFoundException('Project not found');
    const oldProjects = rows(input?.projects, 'projects');
    const notes = rows(input?.notes, 'notes');
    const unlinks = rows(input?.unlinks, 'unlinks');

    const settings = oldProjects.length ? await this.importSettings(projectId, oldProjects) : null;

    const labelValues = notes
      .map((n) => ({
        projectId,
        address: String(n.wallet ?? '').toLowerCase(),
        label: String(n.label ?? '')
          .trim()
          .slice(0, 100),
        note: String(n.note ?? '')
          .trim()
          .slice(0, 2000),
        updatedBy: userId,
        updatedAt: when(n.at),
      }))
      .filter((n) => ADDRESS.test(n.address) && (n.label || n.note));
    const labelsAdded = labelValues.length
      ? (
          await this.db
            .insert(holderWalletLabels)
            .values(labelValues)
            .onConflictDoNothing()
            .returning({ a: holderWalletLabels.address })
        ).length
      : 0;

    const seen = new Set<string>();
    const unlinkValues = unlinks
      .map((u) => {
        const [a, b] = [String(u.a ?? '').toLowerCase(), String(u.b ?? '').toLowerCase()].sort();
        return { projectId, a, b, createdBy: userId, createdAt: when(u.at) };
      })
      .filter(
        (u) =>
          ADDRESS.test(u.a) &&
          ADDRESS.test(u.b) &&
          u.a !== u.b &&
          !seen.has(`${u.a}${u.b}`) &&
          seen.add(`${u.a}${u.b}`),
      );
    const unlinksAdded = unlinkValues.length
      ? (
          await this.db
            .insert(holderWalletUnlinks)
            .values(unlinkValues)
            .onConflictDoNothing()
            .returning({ a: holderWalletUnlinks.a })
        ).length
      : 0;

    return {
      settings,
      labels: {
        sent: notes.length,
        added: labelsAdded,
        kept: labelValues.length - labelsAdded,
        skipped: notes.length - labelValues.length,
      },
      unlinks: {
        sent: unlinks.length,
        added: unlinksAdded,
        kept: unlinkValues.length - unlinksAdded,
        skipped: unlinks.length - unlinkValues.length,
      },
    };
  }

  /**
   * Takes the old project whose contracts match this project's collections best and saves each
   * matching collection's settings. Collections the old app had and this project doesn't are listed.
   */
  private async importSettings(projectId: string, oldProjects: Record<string, unknown>[]) {
    const ours = await this.db.query.collections.findMany({
      columns: { id: true, name: true, chain: true, contractAddress: true },
      where: eq(collections.projectId, projectId),
    });
    // The old app read Ethereum mainnet only.
    const byContract = new Map(
      ours.filter((c) => c.chain === 'ethereum').map((c) => [c.contractAddress.toLowerCase(), c]),
    );

    const parsed = oldProjects.map((p) => {
      let list: unknown = p.collections;
      if (typeof list === 'string') {
        try {
          list = JSON.parse(list);
        } catch {
          list = [];
        }
      }
      const cols = (Array.isArray(list) ? list : []) as OldCollection[];
      return {
        id: String(p.id ?? ''),
        name: String(p.name ?? p.id ?? ''),
        cols,
        matches: cols.filter((c) => byContract.has(String(c.contract ?? '').toLowerCase())).length,
      };
    });
    const best = parsed.sort((a, b) => b.matches - a.matches)[0];
    // No match isn't an error: the labels and unlinks can still come over.
    if (!best?.matches)
      return {
        from: null,
        saved: [] as string[],
        kept: [] as string[],
        failed: [] as { collection: string; error: string }[],
        missing: parsed.flatMap((p) =>
          p.cols.map((c) => `${String(c.id ?? '')} (${String(c.contract ?? '').toLowerCase()})`),
        ),
      };

    // Collections already set up in Nexus keep their settings: saving over them could also
    // throw away their synced transfers (a standard or decimals change re-reads the chain).
    const savedHere = new Set(
      (await this.admin.status(projectId)).collections
        .filter((c) => c.settings?.saved)
        .map((c) => c.collectionId),
    );

    // The old app's defaults: ERC-721s are core unless said otherwise, and with no core collection all are.
    const coreOf = (c: OldCollection) =>
      typeof c.core === 'boolean' ? c.core : c.standard === 'erc721';
    const allCore = !best.cols.some(coreOf);
    const saved: string[] = [];
    const kept: string[] = [];
    const failed: { collection: string; error: string }[] = [];
    const missing: string[] = [];
    for (const c of best.cols) {
      const contract = String(c.contract ?? '').toLowerCase();
      const ours = byContract.get(contract);
      if (!ours) {
        missing.push(`${String(c.id ?? '')} (${contract})`);
        continue;
      }
      if (savedHere.has(ours.id)) {
        kept.push(ours.name);
        continue;
      }
      const standard = typeof c.standard === 'string' ? c.standard : undefined;
      // The old app allowed longer ids; one Nexus can't use leaves the default short id.
      const oldId = typeof c.id === 'string' && SHORT_ID.test(c.id) ? c.id : undefined;
      const values = {
        standard,
        core: allCore || coreOf(c),
        decimals:
          standard === 'erc20' ? (typeof c.decimals === 'number' ? c.decimals : 18) : undefined,
        stakingContracts: Array.isArray(c.staking) ? c.staking.map(String) : undefined,
        tokenNames:
          c.tokenNames && typeof c.tokenNames === 'object' && !Array.isArray(c.tokenNames)
            ? Object.fromEntries(
                Object.entries(c.tokenNames as Record<string, unknown>).map(([k, v]) => [
                  k,
                  String(v),
                ]),
              )
            : undefined,
      };
      try {
        try {
          await this.admin.saveSettings(ours.id, { shortId: oldId, ...values });
        } catch (err) {
          // Another collection here already uses that short id: keep the default one.
          if (!oldId || !(err instanceof BadRequestException) || !/already uses/.test(err.message))
            throw err;
          await this.admin.saveSettings(ours.id, values);
        }
        saved.push(ours.name);
      } catch (err) {
        failed.push({
          collection: ours.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { from: best.name as string | null, saved, kept, failed, missing };
  }
}
