'use client';

import { useState, useRef, useEffect } from 'react';
import { useResolveDomain } from '@/hooks/use-resolve-domain';
import { useWalletNicknames, useSetNickname } from '@/hooks/use-wallet-nicknames';
import { useAuth } from '@/context/auth-context';
import { truncateAddress } from '@/lib/utils';

interface AddressDisplayProps {
  address: string;
  /** Chain hint — auto-detected from address format if omitted */
  chain?: string;
  /** Pre-resolved domain name from DB (skips on-the-fly resolution) */
  knownDomain?: string | null;
  /** Number of leading/trailing chars for truncation (default 4) */
  chars?: number;
  className?: string;
}

/**
 * Displays a wallet address with resolution priority:
 * 1. User's personal nickname (if logged in and set)
 * 2. ENS/SNS domain name
 * 3. Truncated address
 *
 * Hover shows the raw address in a tooltip.
 * Authenticated users can click the pencil icon to set a personal nickname.
 * Copy-to-clipboard in parent components still copies the raw address.
 */
export function AddressDisplay({
  address,
  chain,
  knownDomain,
  chars = 4,
  className,
}: AddressDisplayProps) {
  const { user } = useAuth();
  const nicknames = useWalletNicknames();
  const { mutate: saveNickname } = useSetNickname();
  const { domain } = useResolveDomain(address, chain, knownDomain);

  const nickname = nicknames[address] ?? null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(nickname ?? '');
    setEditing(true);
  };

  const commitEdit = () => {
    const trimmed = draft.trim();
    saveNickname({
      address,
      nickname: trimmed || null,
    });
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const displayText = nickname || domain || truncateAddress(address, chars);

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitEdit();
          if (e.key === 'Escape') cancelEdit();
        }}
        onBlur={commitEdit}
        onClick={(e) => e.stopPropagation()}
        maxLength={100}
        placeholder={domain || truncateAddress(address, chars)}
        className="inline-block w-32 rounded border border-purple-600 bg-gray-900 px-1.5 py-0.5 text-xs text-white outline-none focus:ring-1 focus:ring-purple-500"
      />
    );
  }

  return (
    <span className={`group/addr inline-flex items-center gap-1 ${className ?? ''}`} title={address}>
      <span>{displayText}</span>
      {user && (
        <button
          type="button"
          onClick={startEditing}
          className="hidden text-gray-600 hover:text-purple-400 group-hover/addr:inline-flex"
          title={nickname ? 'Edit nickname' : 'Set nickname'}
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
          </svg>
        </button>
      )}
    </span>
  );
}
