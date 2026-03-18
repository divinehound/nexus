import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { formatPrice, truncateAddress, chainCurrency } from '@/lib/utils';

interface CollectionPageProps {
  params: Promise<{ slug: string; collection: string }>;
}

interface CollectionDetail {
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
  project: { id: string; name: string; slug: string };
  marketSnapshots: { timestamp: string; floorPrice: number | null; volume24h: number | null; holderCount: number | null }[];
}

export default async function CollectionPage({ params }: CollectionPageProps) {
  const { slug, collection: contractAddress } = await params;

  let collection: CollectionDetail | null = null;
  try {
    collection = await apiFetch<CollectionDetail>(`/collections/address/${contractAddress}`);
  } catch {
    // Collection not found
  }

  if (!collection) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <nav className="text-sm text-gray-500">
          <Link href={`/project/${slug}`} className="hover:text-white">{slug}</Link>
          <span className="mx-2">/</span>
          <span className="text-white">{truncateAddress(contractAddress)}</span>
        </nav>
        <h1 className="mt-4 text-3xl font-bold">Collection not found</h1>
        <Link href={`/project/${slug}`} className="mt-4 inline-block text-purple-400 hover:text-purple-300">
          Back to project
        </Link>
      </main>
    );
  }

  const currency = chainCurrency(collection.chain);

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <nav className="text-sm text-gray-500">
        <Link href={`/project/${slug}`} className="hover:text-white">
          {collection.project.name}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-white">{collection.name}</span>
      </nav>

      <div className="mt-6 flex items-start gap-6">
        {collection.imageUrl && (
          <img src={collection.imageUrl} alt={collection.name} className="h-24 w-24 rounded-xl object-cover" />
        )}
        <div>
          <h1 className="text-3xl font-bold">{collection.name}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {collection.chain} · {collection.collectionType} · {truncateAddress(collection.contractAddress)}
          </p>
        </div>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Floor Price" value={collection.floorPrice !== null ? formatPrice(collection.floorPrice, currency) : '—'} />
        <StatCard label="Holders" value={collection.holderCount?.toLocaleString() ?? '—'} />
        <StatCard label="Supply" value={collection.supply?.toLocaleString() ?? '—'} />
        <StatCard label="Listed" value={collection.listedCount?.toLocaleString() ?? '—'} />
      </div>

      {collection.mintDate && (
        <p className="mt-4 text-sm text-gray-500">
          Minted: {new Date(collection.mintDate).toLocaleDateString()}
        </p>
      )}

      {collection.marketSnapshots?.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Market History</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-800 text-gray-500">
                <tr>
                  <th className="pb-2">Date</th>
                  <th className="pb-2">Floor</th>
                  <th className="pb-2">Volume 24h</th>
                  <th className="pb-2">Holders</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                {collection.marketSnapshots.slice(0, 14).map((s, i) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="py-2">{new Date(s.timestamp).toLocaleDateString()}</td>
                    <td>{s.floorPrice !== null ? formatPrice(s.floorPrice, currency) : '—'}</td>
                    <td>{s.volume24h !== null ? formatPrice(s.volume24h, currency) : '—'}</td>
                    <td>{s.holderCount?.toLocaleString() ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
