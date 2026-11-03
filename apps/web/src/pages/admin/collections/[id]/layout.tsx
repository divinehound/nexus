import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useOutletContext, useParams } from 'react-router';
import { toast } from 'sonner';
import { CHAIN_META } from '@nexus/types';
import { useAuth } from '@/context/auth-context';
import { confirmDialog, promptDialog } from '@/components/ui/dialogs';
import {
  ApiError,
  adminGetCollection,
  adminResetCollectionName,
  adminUpdateCollection,
  type AdminCollectionDetail,
} from '@/lib/api';
import { mediaUrl } from '@/lib/media';
import { cn, explorerAddressUrl } from '@/lib/utils';

export interface AdminCollectionContext {
  collection: AdminCollectionDetail;
  setCollection: (c: AdminCollectionDetail) => void;
  reload: () => Promise<void>;
}

/** The tabs below this header read the loaded collection from here. */
export function useAdminCollection() {
  return useOutletContext<AdminCollectionContext>();
}

const TAB = 'border-b-2 px-1 pb-2 text-sm font-medium';

/** Admin page for one collection: a header with the name, then Overview and Holder history tabs. */
export default function AdminCollectionLayout() {
  const { accessToken } = useAuth();
  const collectionId = useParams<{ id: string }>().id ?? '';
  const [collection, setCollection] = useState<AdminCollectionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  const reload = useCallback(async () => {
    if (!accessToken || !collectionId) return;
    try {
      setCollection(await adminGetCollection(collectionId, accessToken));
      setError(null);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 404 ? 'There is no collection with this id.' : err instanceof Error ? err.message : 'Could not load the collection');
    }
  }, [accessToken, collectionId]);

  useEffect(() => {
    reload();
  }, [reload]);

  if (error) {
    return (
      <div className="space-y-3">
        <Link to="/admin/collections" className="text-xs text-purple-400 hover:text-purple-300">
          ← Collections
        </Link>
        <p className="text-sm text-red-300">{error}</p>
      </div>
    );
  }

  if (!collection) {
    return (
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
        <span className="text-gray-400">Loading collection...</span>
      </div>
    );
  }

  const rename = async () => {
    if (!accessToken) return;
    const name = await promptDialog({
      title: 'Rename collection',
      message: 'Nexus shows this name everywhere. Metadata refreshes keep it until you reset it.',
      label: 'Name',
      defaultValue: collection.name,
      required: true,
      maxLength: 255,
      confirmText: 'Rename',
    });
    if (name === null || name.trim() === collection.name) return;
    setRenaming(true);
    try {
      setCollection(await adminUpdateCollection(collection.id, { name }, accessToken));
      toast.success('Collection renamed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename the collection');
    } finally {
      setRenaming(false);
    }
  };

  const resetName = async () => {
    if (!accessToken) return;
    const ok = await confirmDialog({
      title: 'Use the name from chain metadata?',
      message: `"${collection.name}" will be replaced by the name from the contract's metadata, and future refreshes will update it.`,
      confirmText: 'Reset name',
    });
    if (!ok) return;
    setRenaming(true);
    try {
      const result = await adminResetCollectionName(collection.id, accessToken);
      setCollection(result.collection);
      if (result.refreshed) toast.success(`Name reset to "${result.collection.name}"`);
      else toast.info('No metadata found right now. The name will update on the next successful refresh.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reset the name');
    } finally {
      setRenaming(false);
    }
  };

  const chainName = CHAIN_META[collection.chain as keyof typeof CHAIN_META]?.name ?? collection.chain;
  const explorer = explorerAddressUrl(collection.chain, collection.contractAddress);
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    cn(TAB, isActive ? 'border-purple-500 text-white' : 'border-transparent text-gray-400 hover:text-gray-200');

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/collections" className="text-xs text-purple-400 hover:text-purple-300">
          ← Collections
        </Link>
        <div className="mt-2 flex items-start gap-4">
          {collection.imageUrl ? (
            <img src={mediaUrl(collection.imageUrl)} alt="" className="h-16 w-16 flex-none rounded-lg object-cover" />
          ) : (
            <div className="h-16 w-16 flex-none rounded-lg bg-gray-800" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{collection.name}</h2>
              <button
                onClick={rename}
                disabled={renaming}
                className="rounded border border-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:border-gray-500 hover:text-white disabled:opacity-50"
              >
                Rename
              </button>
              {collection.nameEditedAt && (
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <span title={`Renamed ${new Date(collection.nameEditedAt).toLocaleString()}`}>Renamed by an admin ·</span>
                  <button onClick={resetName} disabled={renaming} className="text-purple-400 hover:text-purple-300 disabled:opacity-50">
                    Reset to chain name
                  </button>
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              <span>{chainName}</span>
              <span className="break-all font-mono">{collection.contractAddress}</span>
              {explorer && (
                <a href={explorer} target="_blank" rel="noopener noreferrer" className="text-purple-400 hover:text-purple-300">
                  Explorer ↗
                </a>
              )}
              <Link to={`/collection/${collection.chain}/${collection.contractAddress}`} className="text-purple-400 hover:text-purple-300">
                Public page
              </Link>
            </div>
          </div>
        </div>
      </div>

      <nav className="flex gap-6 border-b border-gray-800">
        <NavLink to="." end className={tabClass}>
          Overview
        </NavLink>
        <NavLink to="holder-history" className={tabClass}>
          Holder history
        </NavLink>
      </nav>

      <Outlet context={{ collection, setCollection, reload } satisfies AdminCollectionContext} />
    </div>
  );
}
