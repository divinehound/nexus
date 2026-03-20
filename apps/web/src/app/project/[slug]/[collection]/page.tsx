import Link from 'next/link';
import { apiFetch, getCollectionStats, type CollectionStatsResponse, type CollectionVerificationStatus } from '@/lib/api';
import { TrustBadge, TrustDisclaimer } from '@/components/trust/trust-badge';
import { formatPrice, truncateAddress, chainCurrency } from '@/lib/utils';

interface CollectionPageProps {
  params: Promise<{ slug: string; collection: string }>;
}

interface ProjectCollection {
  id: string;
  name: string;
  contractAddress: string;
  chain: string;
  supply: number | null;
  floorPrice: number | null;
  holderCount: number | null;
  listedCount: number | null;
  imageUrl: string | null;
  mintDate: string | null;
  collectionType: string;
  verificationStatus: CollectionVerificationStatus;
}

interface ProjectData {
  id: string;
  name: string;
  slug: string;
  collections: ProjectCollection[];
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export default async function CollectionPage({ params }: CollectionPageProps) {
  const { slug, collection: contractAddress } = await params;

  let project: ProjectData | null = null;
  try {
    project = await apiFetch<ProjectData>(`/projects/${slug}`);
  } catch {
    // handled below
  }

  const collection = project?.collections?.find(
    (c) => c.contractAddress.toLowerCase() === contractAddress.toLowerCase(),
  ) ?? null;

  if (!project || !collection) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <nav className="text-sm text-gray-500">
          <Link href={`/project/${slug}`} className="hover:text-white">{slug}</Link>
          <span className="mx-2">/</span>
          <span className="text-white">{truncateAddress(contractAddress)}</span>
        </nav>
        <h1 className="mt-4 text-3xl font-bold">Collection not found</h1>
        <p className="mt-2 text-sm text-gray-400">
          This collection is not mapped under the selected project yet.
        </p>
        <div className="mt-4 flex items-center gap-4">
          <Link href={`/project/${slug}/${contractAddress}`} className="text-purple-400 hover:text-purple-300">
            Retry
          </Link>
          <Link href={`/project/${slug}`} className="text-purple-400 hover:text-purple-300">
            Back to project
          </Link>
        </div>
      </main>
    );
  }

  let stats: CollectionStatsResponse | null = null;
  try {
    stats = await getCollectionStats(collection.chain, collection.contractAddress);
  } catch {
    stats = null;
  }

  const currency = chainCurrency(collection.chain);
  const metrics = stats?.current;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <nav className="text-sm text-gray-500">
        <Link href={`/project/${slug}`} className="hover:text-white">
          {project.name}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-white">{collection.name}</span>
      </nav>

      <div className="mt-6 flex items-start gap-6">
        {collection.imageUrl && (
          <img src={collection.imageUrl} alt={collection.name} className="h-24 w-24 rounded-xl object-cover" />
        )}
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-bold">{collection.name}</h1>
            <TrustBadge status={collection.verificationStatus} />
            {stats?.status === 'indexing' && (
              <span className="rounded border border-blue-800 bg-blue-950/60 px-2 py-1 text-xs text-blue-300">
                Indexing in progress
              </span>
            )}
            {stats?.status === 'stale' && (
              <span className="rounded border border-amber-800 bg-amber-950/60 px-2 py-1 text-xs text-amber-300">
                Stale
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {collection.chain} · {collection.collectionType} · {truncateAddress(collection.contractAddress)}
          </p>
          <TrustDisclaimer status={collection.verificationStatus} />
          {stats?.lastUpdatedAt && (
            <p className="mt-2 text-xs text-gray-500">Last updated {new Date(stats.lastUpdatedAt).toLocaleString()}</p>
          )}
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard
          label="Floor"
          value={
            metrics?.floorPrice !== null && metrics?.floorPrice !== undefined
              ? formatPrice(metrics.floorPrice, currency)
              : collection.floorPrice !== null
                ? formatPrice(collection.floorPrice, currency)
                : '—'
          }
        />
        <StatCard label="Holders" value={formatNumber(metrics?.holderCount ?? collection.holderCount)} />
        <StatCard label="Listed" value={formatNumber(metrics?.listedCount ?? collection.listedCount)} />
        <StatCard
          label="Vol 24h"
          value={
            metrics?.volume24h !== null && metrics?.volume24h !== undefined
              ? formatPrice(metrics.volume24h, currency)
              : '—'
          }
        />
        <StatCard label="Sales 24h" value={formatNumber(metrics?.sales24h)} />
        <StatCard label="Unique buyers" value={formatNumber(metrics?.uniqueBuyers24h)} />
      </div>

      {collection.mintDate && (
        <p className="mt-4 text-sm text-gray-500">
          Minted: {new Date(collection.mintDate).toLocaleDateString()}
        </p>
      )}
    </main>
  );
}
