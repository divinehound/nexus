import type { CollectionVerificationStatus } from '@/lib/api';

const STATUS_LABELS: Record<CollectionVerificationStatus, string> = {
  tracked_unverified: 'Tracked, Unverified',
  pending_claim: 'Pending Claim',
  verified: 'Verified',
  rejected: 'Rejected',
};

const STATUS_STYLES: Record<CollectionVerificationStatus, string> = {
  tracked_unverified: 'bg-yellow-900/30 text-yellow-300 border border-yellow-600/50',
  pending_claim: 'bg-blue-900/30 text-blue-300 border border-blue-600/50',
  verified: 'bg-green-900/30 text-green-300 border border-green-600/50',
  rejected: 'bg-red-900/30 text-red-300 border border-red-600/50',
};

export function TrustBadge({ status }: { status: CollectionVerificationStatus }) {
  return (
    <span className={`rounded px-2 py-1 text-xs font-medium uppercase tracking-wide ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export function TrustDisclaimer({ status }: { status: CollectionVerificationStatus }) {
  if (status !== 'tracked_unverified' && status !== 'rejected') return null;

  return (
    <p className="mt-3 rounded-lg border border-yellow-700/50 bg-yellow-900/20 px-4 py-3 text-sm text-yellow-200">
      Tracked, not yet verified. Data may be incomplete or unaffiliated.
    </p>
  );
}
