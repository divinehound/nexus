'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/auth-context';
import { apiFetch } from '@/lib/api';
import { truncateAddress } from '@/lib/utils';
import { chainDisplayName } from '@nexus/types';

interface BlockchainContractInfo {
  contractAddress: string;
  chain: string;
  name: string;
  symbol: string;
  totalSupply: number | null;
  tokenType: 'erc721' | 'erc1155' | 'spl';
  imageUrl: string | null;
  deployerAddress: string | null;
}

interface ImportResult {
  collection: { id: string; contractAddress: string };
  project: { id: string; slug: string };
  alreadyExisted: boolean;
}

export function BlockchainResults({
  results,
}: {
  results: BlockchainContractInfo[];
}) {
  if (results.length === 0) return null;

  return (
    <section className="mt-10">
      <h2 className="mb-4 text-lg font-semibold text-gray-300">
        Found on Blockchain
      </h2>
      <p className="mb-4 text-sm text-gray-500">
        These contracts were found on-chain but are not yet tracked. Import to
        start generating data.
      </p>
      <div className="space-y-3">
        {results.map((r) => (
          <BlockchainResultCard key={`${r.chain}-${r.contractAddress}`} info={r} />
        ))}
      </div>
    </section>
  );
}

function BlockchainResultCard({ info }: { info: BlockchainContractInfo }) {
  const { accessToken: token } = useAuth();
  const router = useRouter();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<ImportResult | null>(null);

  const handleImport = async () => {
    if (!token) {
      setError('Please connect your wallet to import collections.');
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const result = await apiFetch<ImportResult>('/search/import', {
        method: 'POST',
        token,
        body: JSON.stringify({
          contractAddress: info.contractAddress,
          chain: info.chain,
        }),
      });
      setImported(result);
    } catch (err: any) {
      setError(err.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  if (imported) {
    return (
      <div className="flex items-center gap-4 rounded-xl border border-green-800 bg-green-950/30 px-4 py-3">
        <div className="flex-1">
          <h3 className="font-medium text-green-400">
            {info.name} imported successfully
          </h3>
          <p className="text-sm text-gray-500">
            {imported.alreadyExisted
              ? 'This collection already existed.'
              : 'Collection and project created. Data generation has started.'}
          </p>
        </div>
        <button
          onClick={() =>
            router.push(
              `/project/${imported.project.slug}/${info.contractAddress}`,
            )
          }
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500"
        >
          View Collection
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4 rounded-xl border border-dashed border-gray-700 px-4 py-3 transition-colors hover:border-gray-500">
      {info.imageUrl && (
        <img
          src={info.imageUrl}
          alt={info.name}
          className="h-12 w-12 rounded-lg object-cover"
        />
      )}
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{info.name}</h3>
          {info.symbol && (
            <span className="text-xs text-gray-500">{info.symbol}</span>
          )}
          <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
            {chainDisplayName(info.chain)}
          </span>
          <span className="rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400 uppercase">
            {info.tokenType}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-gray-500">
          {truncateAddress(info.contractAddress)}
          {info.totalSupply !== null && ` · ${info.totalSupply.toLocaleString()} supply`}
          {info.deployerAddress && ` · Deployer: ${truncateAddress(info.deployerAddress)}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          onClick={handleImport}
          disabled={importing}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-purple-500 disabled:opacity-50"
        >
          {importing ? 'Importing...' : 'Import Collection'}
        </button>
      </div>
    </div>
  );
}
