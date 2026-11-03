import { Link, useParams } from 'react-router';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CHAIN_META } from '@nexus/types';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/context/auth-context';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { HolderAnalysisAdminPanel } from '@/components/holder-analysis/admin-panel';
import { mediaUrl } from '@/lib/media';

interface CollectionRow {
  id: string;
  name: string;
  chain: string;
  contractAddress: string;
  imageUrl: string | null;
  holderCount: number | null;
  supply: number | null;
  verificationStatus: string;
  mappingStatus: string;
  isSpam: boolean | null;
}

interface Suggestion extends CollectionRow {
  reason: 'suggested' | 'name';
}

interface SearchRow extends CollectionRow {
  project?: { id: string; name: string; slug: string } | null;
}

interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  discordUrl: string | null;
  isVerified: boolean;
  collections: CollectionRow[];
  suggestions: Suggestion[];
}

type Fields = Pick<ProjectDetail, 'name' | 'slug' | 'description' | 'imageUrl' | 'websiteUrl' | 'twitterUrl' | 'discordUrl'>;

const FIELD_LABELS: [keyof Fields, string][] = [
  ['name', 'Name'],
  ['slug', 'Slug'],
  ['imageUrl', 'Image URL'],
  ['websiteUrl', 'Website'],
  ['twitterUrl', 'X / Twitter'],
  ['discordUrl', 'Discord'],
];

const CHAINS = Object.entries(CHAIN_META).map(([id, meta]) => ({ id, name: meta.name }));
const INPUT =
  'w-full rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white placeholder-gray-500 outline-none focus:border-purple-500';

function shortAddress(address: string) {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function CollectionLine({ c, children }: { c: CollectionRow; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        {c.imageUrl ? (
          <img src={mediaUrl(c.imageUrl)} alt="" className="h-8 w-8 flex-none rounded object-cover" />
        ) : (
          <div className="h-8 w-8 flex-none rounded bg-gray-800" />
        )}
        <div className="min-w-0">
          <Link to={`/collection/${c.chain}/${c.contractAddress}`} className="block truncate text-sm font-medium hover:text-purple-300">
            {c.name}
          </Link>
          <div className="flex flex-wrap gap-x-2 text-xs text-gray-500">
            <span>{CHAIN_META[c.chain as keyof typeof CHAIN_META]?.name ?? c.chain}</span>
            <span className="font-mono">{shortAddress(c.contractAddress)}</span>
            {c.holderCount != null && <span>{c.holderCount.toLocaleString()} holders</span>}
            {c.isSpam && <span className="text-red-400">spam</span>}
          </div>
        </div>
      </div>
      <div className="flex flex-none items-center gap-2">{children}</div>
    </div>
  );
}

export default function AdminProjectEditorPage() {
  const { accessToken } = useAuth();
  const projectId = useParams<{ id: string }>().id ?? null;
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [fields, setFields] = useState<Fields | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [chain, setChain] = useState('ethereum');
  const [contract, setContract] = useState('');
  const [moveTarget, setMoveTarget] = useState<SearchRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CollectionRow | null>(null);

  const load = useCallback(async () => {
    if (!accessToken || !projectId) return;
    try {
      const data = await apiFetch<ProjectDetail>(`/admin/projects/${projectId}`, { token: accessToken });
      setProject(data);
      setFields((prev) =>
        prev ?? {
          name: data.name,
          slug: data.slug,
          description: data.description,
          imageUrl: data.imageUrl,
          websiteUrl: data.websiteUrl,
          twitterUrl: data.twitterUrl,
          discordUrl: data.discordUrl,
        },
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the project');
    }
  }, [accessToken, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  // Search tracked collections as you type.
  useEffect(() => {
    if (!accessToken || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await apiFetch<{ items: SearchRow[] }>(
          `/admin/collections/search?q=${encodeURIComponent(query.trim())}&limit=20`,
          { token: accessToken },
        );
        setResults(data.items ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [accessToken, query]);

  const save = async () => {
    if (!accessToken || !project || !fields) return;
    setSaving(true);
    try {
      const updated = await apiFetch<ProjectDetail>(`/admin/projects/${project.id}`, {
        method: 'PATCH',
        token: accessToken,
        body: JSON.stringify(fields),
      });
      setProject(updated);
      setFields((f) => (f ? { ...f, slug: updated.slug } : f));
      toast.success('Project saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const add = async (body: { collectionId?: string; chain?: string; contractAddress?: string }, label: string) => {
    if (!accessToken || !project) return;
    setBusy(body.collectionId ?? 'contract');
    try {
      const res = await apiFetch<{ tracked: boolean; movedFrom: { id: string; name: string } | null }>(`/admin/projects/${project.id}/collections`, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify(body),
      });
      toast.success(
        res.tracked
          ? `${label} is now tracked and added`
          : res.movedFrom
            ? `${label} moved here from ${res.movedFrom.name}`
            : `${label} added`,
      );
      setContract('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the collection');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (c: CollectionRow) => {
    if (!accessToken || !project) return;
    setBusy(c.id);
    try {
      await apiFetch(`/admin/projects/${project.id}/collections/${c.id}`, { method: 'DELETE', token: accessToken });
      toast.success(`${c.name} removed from ${project.name}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the collection');
    } finally {
      setBusy(null);
      setRemoveTarget(null);
    }
  };

  // Collections in another real project need a confirmation before they move here.
  const pick = (c: SearchRow) => {
    const elsewhere = c.project && c.project.id !== project?.id;
    if (elsewhere) setMoveTarget(c);
    else add({ collectionId: c.id }, c.name);
  };

  if (!project || !fields) {
    return (
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
        <span className="text-gray-400">Loading project...</span>
      </div>
    );
  }

  const inProject = new Set(project.collections.map((c) => c.id));

  return (
    <div className="space-y-8">
      <div>
        <Link to="/admin/projects" className="text-xs text-purple-400 hover:text-purple-300">
          ← Projects
        </Link>
        <h2 className="mt-1 text-xl font-semibold">{project.name}</h2>
        <Link to={`/project/${project.slug}`} className="text-xs text-gray-500 hover:text-gray-300">
          /project/{project.slug}
        </Link>
      </div>

      <section className="rounded-xl border border-gray-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-300">Details</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELD_LABELS.map(([key, label]) => (
            <label key={key} className="block text-xs text-gray-400">
              {label}
              <input
                className={`${INPUT} mt-1`}
                value={fields[key] ?? ''}
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="block text-xs text-gray-400 sm:col-span-2">
            Description
            <textarea
              className={`${INPUT} mt-1 min-h-[72px]`}
              value={fields.description ?? ''}
              onChange={(e) => setFields({ ...fields, description: e.target.value })}
            />
          </label>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="mt-3 rounded bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save details'}
        </button>
      </section>

      <section className="rounded-xl border border-gray-800">
        <h3 className="border-b border-gray-800 px-4 py-3 text-sm font-medium text-gray-300">
          Collections ({project.collections.length})
        </h3>
        {project.collections.length === 0 ? (
          <p className="px-4 py-3 text-sm text-gray-500">No collections yet. Add some below.</p>
        ) : (
          <div className="divide-y divide-gray-800">
            {project.collections.map((c) => (
              <CollectionLine key={c.id} c={c}>
                <button
                  onClick={() => setRemoveTarget(c)}
                  disabled={busy === c.id}
                  className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
                >
                  Remove
                </button>
              </CollectionLine>
            ))}
          </div>
        )}
      </section>

      {project.suggestions.length > 0 && (
        <section className="rounded-xl border border-gray-800">
          <h3 className="border-b border-gray-800 px-4 py-3 text-sm font-medium text-gray-300">
            Likely belongs here ({project.suggestions.length})
          </h3>
          <div className="divide-y divide-gray-800">
            {project.suggestions.map((c) => (
              <CollectionLine key={c.id} c={c}>
                <span className="text-xs text-gray-500">{c.reason === 'suggested' ? 'Suggested' : 'Name match'}</span>
                <button
                  onClick={() => add({ collectionId: c.id }, c.name)}
                  disabled={busy === c.id}
                  className="rounded bg-purple-600 px-2 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
                >
                  Add
                </button>
              </CollectionLine>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-gray-800 p-4">
        <h3 className="mb-3 text-sm font-medium text-gray-300">Add collections</h3>
        <input
          className={INPUT}
          placeholder="Search tracked collections by name or contract"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {searching && <p className="mt-2 text-xs text-gray-500">Searching…</p>}
        {results.length > 0 && (
          <div className="mt-2 divide-y divide-gray-800 rounded border border-gray-800">
            {results.map((c) => (
              <CollectionLine key={c.id} c={c}>
                {c.project && c.project.id !== project.id && (
                  <span className="text-xs text-amber-300">in {c.project.name}</span>
                )}
                {inProject.has(c.id) ? (
                  <span className="text-xs text-gray-500">In this project</span>
                ) : (
                  <button
                    onClick={() => pick(c)}
                    disabled={busy === c.id}
                    className="rounded bg-purple-600 px-2 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
                  >
                    Add
                  </button>
                )}
              </CollectionLine>
            ))}
          </div>
        )}

        <div className="mt-4 text-xs text-gray-400">Or paste a contract. If Nexus doesn&apos;t track it yet, it&apos;s tracked first.</div>
        <div className="mt-1 flex flex-col gap-2 sm:flex-row">
          <select value={chain} onChange={(e) => setChain(e.target.value)} className="rounded border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-white">
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input className={INPUT} placeholder="Contract address" value={contract} onChange={(e) => setContract(e.target.value)} />
          <button
            onClick={() => add({ chain, contractAddress: contract.trim() }, shortAddress(contract.trim()))}
            disabled={!contract.trim() || busy === 'contract'}
            className="flex-none rounded bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50"
          >
            {busy === 'contract' ? 'Adding…' : 'Add contract'}
          </button>
        </div>
      </section>

      {accessToken && (
        <HolderAnalysisAdminPanel key={project.collections.map((c) => c.id).join(',')} projectId={project.id} slug={project.slug} token={accessToken} />
      )}

      <ConfirmModal
        isOpen={!!moveTarget}
        onClose={() => setMoveTarget(null)}
        onConfirm={() => {
          if (moveTarget) add({ collectionId: moveTarget.id }, moveTarget.name);
          setMoveTarget(null);
        }}
        title="Move this collection?"
        message={`${moveTarget?.name ?? ''} is in ${moveTarget?.project?.name ?? 'another project'}. Adding it here takes it out of that project.`}
        confirmText="Move here"
        variant="warning"
      />
      <ConfirmModal
        isOpen={!!removeTarget}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && remove(removeTarget)}
        title="Remove from project?"
        message={`${removeTarget?.name ?? ''} stays tracked in Nexus but won't belong to ${project.name}.`}
        confirmText="Remove"
        variant="danger"
        loading={!!removeTarget && busy === removeTarget.id}
      />
    </div>
  );
}
