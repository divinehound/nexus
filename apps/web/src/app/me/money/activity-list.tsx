'use client';

import { useMemo, useState } from 'react';
import type {
  CashflowActivity,
  CashflowActivityLeg,
  CashflowFlag,
  CashflowReport,
  CashflowResponse,
  CashflowTxType,
} from '@nexus/types';
import { addCashflowLink } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { FlagControl, flagKey, flagsByTx } from './flags';
import {
  CHAIN_LABELS,
  TX_TYPE_LABELS,
  addressExplorerUrl,
  explorerName,
  pnlClass,
  qty,
  txExplorerUrl,
  usd,
  usdSigned,
} from './format';

/** A mint or receive where no payment from the user's wallets was found. */
const isFreeMint = (a: CashflowActivity) =>
  a.type === 'received_asset' && a.legs.some((l) => l.direction === 'in' && l.counterparty === '');

const ACTIVITY_FILTERS: Array<{
  id: string;
  label: string;
  match: ((a: CashflowActivity) => boolean) | null;
}> = [
  { id: 'all', label: 'All', match: null },
  {
    id: 'buys',
    label: 'Buys & mints',
    match: (a) => ['nft_purchase', 'nft_mint', 'token_purchase'].includes(a.type),
  },
  { id: 'free', label: 'Free mints', match: isFreeMint },
  { id: 'sales', label: 'Sales', match: (a) => ['nft_sale', 'token_sale'].includes(a.type) },
  {
    id: 'transfers',
    label: 'Transfers',
    match: (a) =>
      [
        'transfer_in',
        'transfer_out',
        'sent_asset',
        'received_asset',
        'own_wallet_transfer',
        'bridge',
      ].includes(a.type),
  },
  {
    id: 'exchanges',
    label: 'Exchanges',
    match: (a) => a.type === 'exchange_deposit' || a.type === 'exchange_withdrawal',
  },
  { id: 'swaps', label: 'Swaps', match: (a) => a.type === 'swap' },
  // Matched against the report's flags in ActivityList.
  { id: 'flagged', label: '⚑ Flagged', match: null },
];
const PAGE = 50;

const OUTGOING: CashflowTxType[] = ['transfer_out', 'exchange_deposit'];
const INCOMING: CashflowTxType[] = ['transfer_in', 'exchange_withdrawal'];
const LINK_SOURCE_LABELS = {
  auto: 'Matched automatically',
  manual: 'Linked by you',
  relay: 'From Relay records',
} as const;

export function ActivityList({ report }: { report: CashflowReport }) {
  const [filter, setFilter] = useState('all');
  const [order, setOrder] = useState<'newest' | 'oldest'>('newest');
  const [limit, setLimit] = useState(PAGE);
  const [linking, setLinking] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const match = ACTIVITY_FILTERS.find((f) => f.id === filter)?.match;
  const multiWallet = new Set(report.wallets.map((w) => w.address.toLowerCase())).size > 1;
  const flags = useMemo(() => flagsByTx(report), [report]);

  const rows = useMemo(() => {
    // "All" skips unsolicited airdrops (no money, no gas) — they're still under Transfers.
    const filtered = match
      ? report.activity.filter(match)
      : filter === 'flagged'
        ? report.activity.filter((a) => flags.has(flagKey(a.chain, a.txHash)))
        : report.activity.filter(
            (a) =>
              !(a.type === 'received_asset' && a.inUsd === 0 && a.outUsd === 0 && !isFreeMint(a)),
          );
    // The API sends newest first.
    return order === 'newest' ? filtered : [...filtered].reverse();
  }, [report.activity, match, order, filter, flags]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Activity type">
          {ACTIVITY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setLimit(PAGE);
              }}
              className={cn(
                'rounded-lg px-3 py-1 text-xs transition-colors',
                filter === f.id
                  ? 'bg-purple-500/15 text-purple-300'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={order}
          onChange={(e) => {
            setOrder(e.target.value as 'newest' | 'oldest');
            setLimit(PAGE);
          }}
          aria-label="Sort by date"
          className="ml-auto rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <p className="mb-3 text-xs text-gray-500">
        Money that left one of your wallets and reappeared in another (a bridge, SimpleSwap, an
        exchange round-trip) can be linked so it isn&apos;t counted as spending. Open{' '}
        <span className="text-gray-400">Details</span> on any row to see exactly what was found in
        that transaction.
        {report.activityTotal > report.activity.length &&
          ` Showing the most recent ${report.activity.length.toLocaleString()} of ${report.activityTotal.toLocaleString()} transactions.`}
      </p>
      <ul className="divide-y divide-gray-800/70">
        {rows.slice(0, limit).map((a) => {
          const key = `${a.chain}:${a.txHash}`;
          return (
            <li key={key} className="py-3">
              <ActivityRow
                a={a}
                flagged={flags.has(flagKey(a.chain, a.txHash))}
                showWallet={multiWallet}
                onLink={() => setLinking(linking === key ? null : key)}
                linkOpen={linking === key}
                detailsOpen={open === key}
                onDetails={() => setOpen(open === key ? null : key)}
              />
              {open === key && <TxDetails a={a} flag={flags.get(flagKey(a.chain, a.txHash))} />}
              {linking === key && (
                <LinkPicker source={a} report={report} onDone={() => setLinking(null)} />
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + PAGE)}
          className="mt-3 text-xs text-gray-400 hover:text-white"
        >
          Show more ({rows.length - limit} remaining)
        </button>
      )}
      {rows.length === 0 && <p className="py-6 text-center text-sm text-gray-500">Nothing here.</p>}
    </div>
  );
}

function ExplorerLink({
  chain,
  hash,
  children,
}: {
  chain: string;
  hash: string;
  children?: React.ReactNode;
}) {
  const url = txExplorerUrl(chain, hash);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-purple-300 underline-offset-2 hover:text-purple-200 hover:underline"
    >
      {children ?? `View on ${explorerName(chain)}`} ↗
    </a>
  );
}

function ActivityRow({
  a,
  flagged,
  showWallet,
  onLink,
  linkOpen,
  detailsOpen,
  onDetails,
}: {
  a: CashflowActivity;
  flagged: boolean;
  showWallet: boolean;
  onLink: () => void;
  linkOpen: boolean;
  detailsOpen: boolean;
  onDetails: () => void;
}) {
  const { run, busy } = useCashflowActions();
  const net = a.inUsd - a.outUsd;
  // NFTs/tokens that moved with no money in the same tx may be one half of a
  // trade: paid on another chain (Relay), or an OTC deal paid separately.
  const unpaid = a.type === 'received_asset';
  const unsold = a.type === 'sent_asset';
  // A trade's payment can take more transfers (one payment, NFTs sent in several txs).
  const tradePayment = a.type === 'trade_payment';
  const linkable =
    OUTGOING.includes(a.type) || INCOMING.includes(a.type) || unpaid || unsold || tradePayment;
  const linked = a.linkedTxs ?? (a.linkedTo ? [a.linkedTo] : []);
  const isBridge = a.type === 'bridge';

  const unlink = () => {
    if (linked.length === 0) return;
    // Always record a rejection (the API drops any manual link for the pair
    // first). Just deleting a manual link would let the automatic matcher
    // pair the same two transactions straight back up.
    void run('Unlinked — counted as separate transfers again', async (token, view) => {
      let last: CashflowResponse | null = null;
      for (const other of linked) {
        const pair =
          a.linkSide === 'out'
            ? {
                fromChain: a.chain,
                fromTxHash: a.txHash,
                toChain: other.chain,
                toTxHash: other.txHash,
              }
            : {
                fromChain: other.chain,
                fromTxHash: other.txHash,
                toChain: a.chain,
                toTxHash: a.txHash,
              };
        last = await addCashflowLink(token, { kind: 'unlink', ...pair }, view);
      }
      return last!;
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <div className="w-24 shrink-0 text-xs text-gray-500">
        {new Date(a.timestamp).toLocaleDateString()}
        <div>{CHAIN_LABELS[a.chain] ?? a.chain}</div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300">
            {isFreeMint(a) ? 'Free mint' : TX_TYPE_LABELS[a.type]}
          </span>
          <span className="truncate text-sm text-gray-200">{a.label}</span>
          {flagged && (
            <span className="text-[11px] text-yellow-400" title="You flagged this as wrong">
              ⚑ flagged
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
          {showWallet && <span>wallet {truncateAddress(a.wallet)}</span>}
          {a.counterparty && a.counterparty !== 'contract' && (
            <span className="font-mono">↔ {truncateAddress(a.counterparty)}</span>
          )}
          <ExplorerLink chain={a.chain} hash={a.txHash} />
          {linked.map((l, i) => (
            <ExplorerLink key={`${l.chain}:${l.txHash}`} chain={l.chain} hash={l.txHash}>
              {isBridge
                ? `${a.linkSide === 'out' ? 'Arrival' : 'Departure'} on ${CHAIN_LABELS[l.chain] ?? l.chain}`
                : `Linked tx${linked.length > 1 ? ` ${i + 1}` : ''}${l.chain !== a.chain ? ` on ${CHAIN_LABELS[l.chain] ?? l.chain}` : ''}`}
            </ExplorerLink>
          ))}
          <button
            type="button"
            onClick={onDetails}
            aria-expanded={detailsOpen}
            className="text-gray-400 underline-offset-2 hover:text-white hover:underline"
          >
            {detailsOpen ? 'Hide details' : 'Details'}
          </button>
          {a.linkSource && <span>{LINK_SOURCE_LABELS[a.linkSource]}</span>}
          {linked.length > 0 && (isBridge || a.linkSource) && (
            <button
              type="button"
              disabled={busy}
              onClick={unlink}
              className="text-gray-400 underline-offset-2 hover:text-white hover:underline disabled:opacity-50"
            >
              {linked.length > 1 ? `Unlink all ${linked.length}` : 'Unlink'}
            </button>
          )}
          {linkable && (
            <button
              type="button"
              onClick={onLink}
              aria-expanded={linkOpen}
              className="text-purple-300 underline-offset-2 hover:text-purple-200 hover:underline"
            >
              {linkOpen
                ? 'Cancel'
                : unpaid
                  ? 'Link to its payment…'
                  : unsold
                    ? 'Link to what you were paid…'
                    : tradePayment
                      ? 'Link more transfers…'
                      : 'Link…'}
            </button>
          )}
        </div>
      </div>
      <div className="text-right text-sm tabular-nums">
        {(a.inUsd > 0 || a.outUsd > 0) && <div className={pnlClass(net)}>{usdSigned(net)}</div>}
        {a.realizedPnlUsd !== null && (
          <div className={cn('text-xs', pnlClass(a.realizedPnlUsd))}>
            P/L {usdSigned(a.realizedPnlUsd)}
          </div>
        )}
        {a.feeUsd > 0 && (
          <div className="text-xs text-gray-500">
            {a.type === 'bridge' ? 'fees' : 'gas'} {usd(a.feeUsd)}
          </div>
        )}
      </div>
    </div>
  );
}

function legAsset(l: CashflowActivityLeg): string {
  if (l.kind === 'nft')
    return `${l.name}${l.tokenId ? ` #${l.tokenId.length > 12 ? `${l.tokenId.slice(0, 6)}…` : l.tokenId}` : ''}${l.amount !== 1 ? ` ×${qty(l.amount)}` : ''}`;
  return `${qty(l.amount)} ${l.symbol ?? l.name}`;
}

function Counterparty({ chain, address }: { chain: string; address: string }) {
  if (address === '') return <span>mint / burn (0x0)</span>;
  if (address === 'contract') return <span>a contract call</span>;
  const url = addressExplorerUrl(chain, address);
  const text = address.length > 16 ? truncateAddress(address) : address;
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono hover:text-purple-300"
    >
      {text}
    </a>
  ) : (
    <span className="font-mono">{text}</span>
  );
}

/** Everything the scanner found in one transaction, for checking it against the explorer. */
function TxDetails({ a, flag }: { a: CashflowActivity; flag: CashflowFlag | undefined }) {
  return (
    <div className="mt-2 rounded-lg border border-gray-800 bg-gray-900/40 p-3 text-xs">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 text-gray-400">
        <span>
          {new Date(a.timestamp).toLocaleString()} · {CHAIN_LABELS[a.chain] ?? a.chain}
        </span>
        <span className="font-mono text-gray-500">{truncateAddress(a.txHash, 8)}</span>
        <ExplorerLink chain={a.chain} hash={a.txHash} />
      </div>
      {a.legs.length > 0 ? (
        <table className="w-full">
          <thead className="text-left text-gray-500">
            <tr>
              <th className="py-1 pr-3 font-medium">Direction</th>
              <th className="py-1 pr-3 font-medium">What</th>
              <th className="py-1 pr-3 font-medium">From / to</th>
              <th className="py-1 text-right font-medium">USD</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {a.legs.map((l, i) => (
              <tr key={i}>
                <td
                  className={cn(
                    'py-1 pr-3',
                    l.direction === 'in' ? 'text-sky-300' : 'text-orange-300',
                  )}
                >
                  {l.direction === 'in' ? '← In' : '→ Out'}
                </td>
                <td className="py-1 pr-3 text-gray-200">
                  {legAsset(l)}
                  {l.inferred && (
                    <span
                      className="ml-1 cursor-help text-gray-500"
                      title="Not in the transfer index — worked out from your wallet's balance change around this transaction (ETH moved inside a contract call, or by a smart-contract wallet)."
                    >
                      (from balance change)
                    </span>
                  )}
                </td>
                <td className="py-1 pr-3 text-gray-400">
                  {l.direction === 'in' ? 'from ' : 'to '}
                  <Counterparty chain={a.chain} address={l.counterparty} />
                </td>
                <td className="py-1 text-right tabular-nums text-gray-300">
                  {l.usd === null ? '—' : usd(l.usd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-gray-500">No asset or money moved for your wallets — only gas.</p>
      )}
      {a.feeUsd > 0 && <p className="mt-2 text-gray-500">Gas / fees: {usd(a.feeUsd)}</p>}
      {isFreeMint(a) && (
        <p className="mt-2 text-yellow-500/90">
          No payment from your linked wallets was found in this transaction. If you did pay, the
          money most likely came from a wallet you haven&apos;t linked, from another chain (e.g. a
          Relay cross-chain mint), or in a token we don&apos;t price. Check the transaction on{' '}
          {explorerName(a.chain)} — if the payer is another wallet of yours, add it on your profile;
          if you paid on another chain, use &ldquo;Link to its payment…&rdquo;.
        </p>
      )}
      <FlagControl chain={a.chain} txHash={a.txHash} flag={flag} />
    </div>
  );
}

/** Money value of a transfer row, without the gas. */
const moneyOf = (a: CashflowActivity) =>
  OUTGOING.includes(a.type) ? a.outUsd - a.feeUsd : a.inUsd;

export function LinkPicker({
  source,
  report,
  onDone,
}: {
  source: CashflowActivity;
  report: CashflowReport;
  onDone: () => void;
}) {
  const { run, busy } = useCashflowActions();
  const sourceIsOut = OUTGOING.includes(source.type);
  const assetSource = source.type === 'received_asset' || source.type === 'sent_asset';
  const [manualChain, setManualChain] = useState(
    assetSource ? source.chain : source.chain === 'solana' ? 'ethereum' : 'solana',
  );
  const [manualHash, setManualHash] = useState('');

  // Likely other halves within a week: same person first, then closest in value, then in time.
  const candidates = useMemo(() => {
    // What the other half can be: money for assets and assets for money (a
    // trade — OTC or cross-chain), or money going the other way (a bridge).
    const partnerTypes: CashflowTxType[] =
      source.type === 'trade_payment'
        ? [source.linkSide === 'in' ? 'sent_asset' : 'received_asset']
        : source.type === 'received_asset'
          ? OUTGOING
          : source.type === 'sent_asset'
            ? INCOMING
            : sourceIsOut
              ? [...INCOMING, 'received_asset']
              : [...OUTGOING, 'sent_asset'];
    const t0 = new Date(source.timestamp).getTime();
    const value = moneyOf(source);
    const party = source.counterparty?.toLowerCase() ?? null;
    return report.activity
      .filter((b) => partnerTypes.includes(b.type) && b !== source)
      .map((b) => ({
        b,
        dt: new Date(b.timestamp).getTime() - t0,
        ratio: value > 0 ? moneyOf(b) / value : 0,
        samePerson: !!party && b.counterparty?.toLowerCase() === party,
      }))
      .filter(({ b, dt }) =>
        // Trades can come in either order; a bridge arrives after it leaves.
        assetSource || b.type === 'received_asset' || b.type === 'sent_asset'
          ? Math.abs(dt) < 7 * 86_400_000
          : sourceIsOut
            ? dt > -10 * 60_000 && dt < 7 * 86_400_000
            : dt < 10 * 60_000 && dt > -7 * 86_400_000,
      )
      .sort(
        (x, y) =>
          Number(y.samePerson) - Number(x.samePerson) ||
          Math.abs(1 - x.ratio) - Math.abs(1 - y.ratio) ||
          Math.abs(x.dt) - Math.abs(y.dt),
      )
      .slice(0, 8);
  }, [report.activity, source, sourceIsOut, assetSource]);

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const togglePick = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Link the source to each chosen tx — together they're one trade (e.g. one payment, NFTs in 3 txs). */
  const link = (others: Array<{ chain: string; txHash: string }>) => {
    const pairFor = (o: { chain: string; txHash: string }) =>
      sourceIsOut
        ? {
            fromChain: source.chain,
            fromTxHash: source.txHash,
            toChain: o.chain,
            toTxHash: o.txHash,
          }
        : {
            fromChain: o.chain,
            fromTxHash: o.txHash,
            toChain: source.chain,
            toTxHash: source.txHash,
          };
    void run(
      source.type === 'received_asset'
        ? 'Linked — that payment now counts as what you paid for this'
        : source.type === 'sent_asset'
          ? 'Linked — counted as a sale for that payment'
          : others.length > 1
            ? `Linked ${others.length} transactions as one trade`
            : 'Linked',
      async (token, view) => {
        let last: CashflowResponse | null = null;
        for (const o of others)
          last = await addCashflowLink(token, { kind: 'link', ...pairFor(o) }, view);
        return last!;
      },
    ).then((ok) => ok && onDone());
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3 text-sm">
      <div className="mb-2 text-xs text-gray-400">
        {source.type === 'received_asset'
          ? 'Paid for separately — an OTC deal, or a cross-chain (Relay) mint? Pick the payment.'
          : source.type === 'sent_asset'
            ? 'Sold this in an OTC deal? Pick the payment you received for it.'
            : sourceIsOut
              ? 'Where did this money arrive — or what did it pay for (OTC deal, cross-chain mint)?'
              : 'Where did this money come from — or what did you sell for it?'}
      </div>
      {candidates.length > 0 ? (
        <>
          <ul className="space-y-1">
            {candidates.map(({ b, dt }) => {
              const key = `${b.chain}:${b.txHash}`;
              return (
                <li key={key}>
                  <label className="flex w-full cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-gray-800">
                    <input
                      type="checkbox"
                      checked={picked.has(key)}
                      disabled={busy}
                      onChange={() => togglePick(key)}
                    />
                    <span className="min-w-0 flex-1 truncate text-gray-200">
                      <span className="text-gray-500">{CHAIN_LABELS[b.chain] ?? b.chain} · </span>
                      {b.label}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-gray-400">
                      {usd(moneyOf(b))} · {formatGap(dt)}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            disabled={busy || picked.size === 0}
            onClick={() =>
              link(
                candidates
                  .filter(({ b }) => picked.has(`${b.chain}:${b.txHash}`))
                  .map(({ b }) => ({ chain: b.chain, txHash: b.txHash })),
              )
            }
            className="mt-2 rounded-md bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
          >
            Link {picked.size > 1 ? `${picked.size} transactions` : 'selected'}
          </button>
          <p className="mt-1 text-[11px] text-gray-500">
            Tick every transaction in the deal — e.g. one payment for NFTs sent in several
            transactions. The money is split across them by number of NFTs and counted once.
          </p>
        </>
      ) : (
        <p className="text-xs text-gray-500">No transfers in the week around this one.</p>
      )}
      <form
        className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-800 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (manualHash.trim()) link([{ chain: manualChain, txHash: manualHash.trim() }]);
        }}
      >
        <label className="text-xs text-gray-400" htmlFor={`link-chain-${source.txHash}`}>
          Or paste a transaction:
        </label>
        <select
          id={`link-chain-${source.txHash}`}
          value={manualChain}
          onChange={(e) => setManualChain(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
        >
          {Object.entries(CHAIN_LABELS).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <input
          value={manualHash}
          onChange={(e) => setManualHash(e.target.value)}
          placeholder="Transaction hash / signature"
          aria-label="Transaction hash or signature"
          className="min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 font-mono text-xs text-gray-200 placeholder:text-gray-600"
        />
        <button
          type="submit"
          disabled={busy || !manualHash.trim()}
          className="rounded-md bg-purple-600 px-3 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
        >
          Link
        </button>
      </form>
      <p className="mt-2 text-[11px] text-gray-500">
        A pasted transaction must be in one of your linked wallets. The difference between what left
        and what arrived is counted as a fee.
      </p>
    </div>
  );
}

function formatGap(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? '−' : '+';
  if (abs < 3_600_000) return `${sign}${Math.round(abs / 60_000)} min`;
  if (abs < 86_400_000) return `${sign}${(abs / 3_600_000).toFixed(1)} h`;
  return `${sign}${(abs / 86_400_000).toFixed(1)} d`;
}
