import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/context/auth-context';
import { confirmDialog, promptDialog } from '@/components/ui/dialogs';
import {
  apiFetch,
  adminDiscoverCollections,
  adminEnrichCollection,
  adminIndexCollectionHolders,
  adminLinkCollectionToProject,
  adminMarkCollectionAsNotSpam,
  adminMarkCollectionAsSpam,
  adminRejectCollection,
  adminSetCollectionServiceLevel,
  adminUpdateCollection,
  adminVerifyCollection,
  type AdminCollectionDetail,
  type AdminCollectionEditableFields,
  SERVICE_LEVELS,
  type ServiceLevel,
} from '@/lib/api';
import { useAdminCollection } from './layout';

type LinkFields = Required<Omit<AdminCollectionEditableFields, 'name'>>;

const LINK_FIELDS: [keyof LinkFields, string][] = [
  ['websiteUrl', 'Website'],
  ['twitterUrl', 'X / Twitter'],
  ['discordUrl', 'Discord'],
  ['telegramUrl', 'Telegram'],
  ['externalUrl', 'External URL'],
];

const INPUT =
  'w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500';
const BUTTON =
  'rounded border border-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:border-gray-500 hover:text-white disabled:opacity-50';
const UNASSIGNED_SLUG = 'unassigned-contract-intake';

function linkFields(c: AdminCollectionDetail): LinkFields {
  return {
    description: c.description,
    websiteUrl: c.websiteUrl,
    twitterUrl: c.twitterUrl,
    discordUrl: c.discordUrl,
    telegramUrl: c.telegramUrl,
    externalUrl: c.externalUrl,
  };
}

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}

function errorMessage(err: unknown, fallback: string) {
  const data = (err as { data?: { message?: unknown } })?.data;
  if (typeof data?.message === 'string') return data.message;
  return err instanceof Error ? err.message : fallback;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-gray-200">{children}</dd>
    </div>
  );
}

export default function AdminCollectionOverviewPage() {
  const { accessToken } = useAuth();
  const { collection: c, setCollection, reload } = useAdminCollection();
  const [fields, setFields] = useState<LinkFields>(() => linkFields(c));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [targetProject, setTargetProject] = useState('');

  useEffect(() => {
    if (!accessToken) return;
    apiFetch<{ items: { id: string; name: string; slug: string }[] }>('/admin/projects?page=1&limit=200', { token: accessToken })
      .then((data) => setProjects(data.items.filter((p) => p.slug !== UNASSIGNED_SLUG)))
      .catch(() => setProjects([]));
  }, [accessToken]);

  const dirty = (Object.keys(fields) as (keyof LinkFields)[]).some((k) => (fields[k] ?? '') !== (c[k] ?? ''));
  const inRealProject = c.project && c.project.slug !== UNASSIGNED_SLUG ? c.project : null;

  const save = async () => {
    if (!accessToken) return;
    setSaving(true);
    try {
      const updated = await adminUpdateCollection(c.id, fields, accessToken);
      setCollection(updated);
      setFields(linkFields(updated));
      toast.success('Collection saved');
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  /** Runs an action with a busy flag, then reloads the collection. */
  const act = async (key: string, run: () => Promise<string | void>, fallback: string) => {
    if (!accessToken) return;
    setBusy(key);
    try {
      const message = await run();
      if (message) toast.success(message);
      await reload();
    } catch (err) {
      toast.error(errorMessage(err, fallback));
    } finally {
      setBusy(null);
    }
  };

  const setServiceLevel = async (value: string) => {
    const level = value === 'auto' ? null : (value as ServiceLevel);
    if (level === 'premium' || level === 'hot') {
      const ok = await confirmDialog({
        title: `Make ${c.name} ${level}?`,
        message:
          level === 'premium'
            ? 'Its holders refresh every hour, which costs the most Alchemy calls.'
            : 'Its holders refresh every 6 hours.',
        confirmText: 'Set level',
      });
      if (!ok) return;
    }
    await act(
      'level',
      async () => {
        await adminSetCollectionServiceLevel(c.id, level, accessToken!);
        return level ? `Pinned to ${SERVICE_LEVELS.find((l) => l.value === level)?.label}` : 'Set to automatic';
      },
      'Could not change the service level',
    );
  };

  const refreshMetadata = () =>
    act(
      'enrich',
      async () => {
        const result = await adminEnrichCollection(c.id, accessToken!);
        if (!result.success) throw new Error(result.message || 'No metadata found');
        return c.nameEditedAt ? 'Metadata refreshed. Your name was kept.' : 'Metadata refreshed';
      },
      'Could not refresh metadata',
    );

  const indexHolders = async () => {
    const ok = await confirmDialog({
      title: 'Index holders?',
      message: `Fetches every holder of ${c.name} from ${c.chain === 'solana' ? 'Helius' : 'Alchemy'}. Large collections can take several minutes.`,
      confirmText: 'Index holders',
    });
    if (!ok) return;
    await act(
      'index',
      async () => {
        const result = await adminIndexCollectionHolders(c.id, accessToken!);
        if (!result.success) throw new Error(result.error || 'Indexing failed');
        return `Indexed ${result.holdersIndexed.toLocaleString()} holders`;
      },
      'Indexing failed',
    );
  };

  const discover = async () => {
    const ok = await confirmDialog({
      title: 'Discover collections?',
      message: "Checks what else this collection's holders own and adds new contracts as unverified. Runs in the background.",
      confirmText: 'Discover',
    });
    if (!ok) return;
    await act('discover', async () => (await adminDiscoverCollections(c.id, {}, accessToken!)).message, 'Discovery failed');
  };

  const verify = () =>
    act(
      'verify',
      async () => {
        await adminVerifyCollection(c.id, {}, accessToken!);
        return 'Collection verified';
      },
      'Could not verify',
    );

  const reject = async () => {
    const notes = await promptDialog({
      title: 'Reject collection?',
      label: 'Notes (optional)',
      confirmText: 'Reject',
      variant: 'danger',
    });
    if (notes === null) return;
    await act(
      'reject',
      async () => {
        await adminRejectCollection(c.id, { notes: notes || undefined }, accessToken!);
        return 'Collection rejected';
      },
      'Could not reject',
    );
  };

  const toggleSpam = async () => {
    if (c.isSpam) {
      const reason = await promptDialog({
        title: 'Mark as not spam?',
        message: `"${c.name}" will be added to the allowlist.`,
        label: 'Reason',
        defaultValue: 'verified_legitimate',
        confirmText: 'Mark as not spam',
      });
      if (reason === null) return;
      await act(
        'spam',
        async () => {
          await adminMarkCollectionAsNotSpam(c.id, reason || undefined, accessToken!);
          return 'Marked as not spam';
        },
        'Could not update spam status',
      );
    } else {
      const notes = await promptDialog({
        title: 'Mark as spam?',
        message: `"${c.name}" will be marked as spam.`,
        label: 'Reason (optional)',
        defaultValue: 'manually_flagged',
        confirmText: 'Mark as spam',
        variant: 'danger',
      });
      if (notes === null) return;
      await act(
        'spam',
        async () => {
          await adminMarkCollectionAsSpam(c.id, notes || undefined, accessToken!);
          return 'Marked as spam';
        },
        'Could not update spam status',
      );
    }
  };

  const moveToProject = async () => {
    const target = projects.find((p) => p.id === targetProject);
    if (!target) return;
    if (inRealProject) {
      const ok = await confirmDialog({
        title: `Move to ${target.name}?`,
        message: `${c.name} is in ${inRealProject.name} now. It can only be in one project.`,
        confirmText: 'Move',
      });
      if (!ok) return;
    }
    await act(
      'project',
      async () => {
        await adminLinkCollectionToProject(c.id, target.id, accessToken!);
        setTargetProject('');
        return `Added to ${target.name}`;
      },
      'Could not change the project',
    );
  };

  const removeFromProject = async () => {
    if (!inRealProject) return;
    const ok = await confirmDialog({
      title: `Remove from ${inRealProject.name}?`,
      message: 'The collection stays tracked, with no project.',
      confirmText: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    await act(
      'project',
      async () => {
        await adminLinkCollectionToProject(c.id, null, accessToken!);
        return `Removed from ${inRealProject.name}`;
      },
      'Could not change the project',
    );
  };

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-300">Facts</h3>
        <dl className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Fact label="Type">{c.collectionType}</Fact>
          <Fact label="Supply">{c.supply?.toLocaleString() ?? '—'}</Fact>
          <Fact label="Holders">{c.holderCount?.toLocaleString() ?? '—'}</Fact>
          <Fact label="Floor">{c.floorPrice ?? '—'}</Fact>
          <Fact label="Verification">{c.verificationStatus}</Fact>
          <Fact label="Mapping">{c.mappingStatus}</Fact>
          <Fact label="Tracking tier">{c.trackingTier}</Fact>
          <Fact label="Service level">
            <select
              className={`${INPUT} w-full`}
              value={c.serviceLevelPinned ? c.serviceLevel : 'auto'}
              disabled={busy === 'level'}
              onChange={(e) => setServiceLevel(e.target.value)}
              aria-label="Service level"
            >
              <option value="auto">
                Automatic{c.serviceLevelPinned ? '' : ` (${SERVICE_LEVELS.find((l) => l.value === c.serviceLevel)?.label.toLowerCase()} now)`}
              </option>
              {SERVICE_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}: {l.refresh}
                </option>
              ))}
            </select>
            {c.serviceLevelReason && <span className="mt-1 block text-xs text-gray-500">{c.serviceLevelReason}</span>}
            {c.serviceLevelCheckedAt && (
              <span className="block text-xs text-gray-600">
                Checked {when(c.serviceLevelCheckedAt)}
                {c.lastTransferAt ? ` · last transfer ${when(c.lastTransferAt)}` : ''}
              </span>
            )}
          </Fact>
          <Fact label="Index status">{c.indexStatus}</Fact>
          <Fact label="Last indexed">
            {when(c.lastIndexFinishedAt)}
            {c.lastIndexStatus && (
              <span className={c.lastIndexStatus === 'success' ? 'text-green-400' : 'text-red-400'}> ({c.lastIndexStatus})</span>
            )}
          </Fact>
          <Fact label="Holder history scanned">{when(c.holderHistoryLastScannedAt)}</Fact>
          <Fact label="First seen">{when(c.firstSeenAt)}</Fact>
          <Fact label="Spam">
            {c.isSpam ? (
              <span className="text-red-400">
                Yes{c.spamReason ? ` · ${c.spamReason}` : ''}
              </span>
            ) : (
              'No'
            )}
            {c.spamScore ? <span className="text-gray-500"> (score {c.spamScore})</span> : null}
          </Fact>
          {c.discoveredFrom && (
            <Fact label="Discovered from">
              <Link to={`/admin/collections/${c.discoveredFrom.id}`} className="text-purple-400 hover:text-purple-300">
                {c.discoveredFrom.name}
              </Link>
              {c.discoveredOverlapCount != null && (
                <span className="text-gray-500"> · {c.discoveredOverlapCount.toLocaleString()} shared holders</span>
              )}
            </Fact>
          )}
          {c.qualityReason && <Fact label="Quality">{c.qualityReason}</Fact>}
        </dl>
        {c.lastIndexError && <p className="mt-3 text-xs text-red-300">Last index error: {c.lastIndexError}</p>}
        {c.verificationNotes && <p className="mt-3 text-xs text-gray-400">Notes: {c.verificationNotes}</p>}
      </section>

      <section className="rounded-xl border border-gray-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-300">Project</h3>
        {inRealProject ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Link to={`/admin/projects/${inRealProject.id}`} className="font-medium text-purple-300 hover:text-purple-200">
              {inRealProject.name}
            </Link>
            <button onClick={removeFromProject} disabled={busy === 'project'} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50">
              Remove from project
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            Not in a project.
            {c.proposedProject && (
              <>
                {' '}
                Suggested:{' '}
                <Link to={`/admin/projects/${c.proposedProject.id}`} className="text-purple-400 hover:text-purple-300">
                  {c.proposedProject.name}
                </Link>
              </>
            )}
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            className={`${INPUT} max-w-xs`}
            value={targetProject}
            onChange={(e) => setTargetProject(e.target.value)}
            aria-label="Project"
          >
            <option value="">{inRealProject ? 'Move to another project…' : 'Add to a project…'}</option>
            {projects
              .filter((p) => p.id !== inRealProject?.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <button onClick={moveToProject} disabled={!targetProject || busy === 'project'} className={BUTTON}>
            {inRealProject ? 'Move' : 'Add'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-gray-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-300">Description and links</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-xs text-gray-400 sm:col-span-2">
            Description
            <textarea
              className={`${INPUT} mt-1 min-h-[72px]`}
              value={fields.description ?? ''}
              onChange={(e) => setFields({ ...fields, description: e.target.value })}
            />
          </label>
          {LINK_FIELDS.map(([key, label]) => (
            <label key={key} className="block text-xs text-gray-400">
              {label}
              <input
                className={`${INPUT} mt-1`}
                value={fields[key] ?? ''}
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="mt-3 rounded bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </section>

      <section className="rounded-xl border border-gray-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-300">Actions</h3>
        <div className="flex flex-wrap gap-2">
          <button onClick={refreshMetadata} disabled={busy !== null} className={BUTTON} title="Image, supply and type from chain metadata">
            {busy === 'enrich' ? 'Refreshing…' : 'Refresh metadata'}
          </button>
          <button onClick={indexHolders} disabled={busy !== null} className={BUTTON}>
            {busy === 'index' ? 'Indexing…' : 'Index holders'}
          </button>
          <button onClick={discover} disabled={busy !== null} className={BUTTON}>
            Discover collections
          </button>
          {c.verificationStatus !== 'verified' && (
            <button onClick={verify} disabled={busy !== null} className={BUTTON}>
              Verify
            </button>
          )}
          {c.verificationStatus !== 'rejected' && (
            <button onClick={reject} disabled={busy !== null} className={BUTTON}>
              Reject
            </button>
          )}
          <button onClick={toggleSpam} disabled={busy !== null} className={BUTTON}>
            {c.isSpam ? 'Mark as not spam' : 'Mark as spam'}
          </button>
        </div>
      </section>
    </div>
  );
}
