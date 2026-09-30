'use client';

import { useMemo, useState } from 'react';
import type {
  CashflowActivity,
  CashflowActivityLeg,
  CashflowFlag,
  CashflowLinkIssue,
  CashflowTxNote,
  CashflowTxShape,
  CashflowReport,
  CashflowResponse,
  CashflowTxType,
} from '@nexus/types';
import { addCashflowLink, removeCashflowContactLabel, removeCashflowLink } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { ExplorerIcon } from './ui';
import { FlagControl, flagKey, flagsByTx } from './flags';
import {
  BulkNameBar,
  ContactChip,
  ContactNameEditor,
  ContactNameOptions,
  NoteEditor,
  RowMenu,
  TxNoteControl,
  contactMenuItems,
  findContactLabel,
  notesByTx,
  useLostMenuItem,
  type MenuItem,
} from './labels';
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

/** Money sent to or received from another address — the transfers a person can be named on. */
const PERSON_TYPES: CashflowTxType[] = [
  'transfer_in',
  'transfer_out',
  'exchange_deposit',
  'exchange_withdrawal',
];
const nameable = (a: CashflowActivity) =>
  PERSON_TYPES.includes(a.type) && !!a.counterparty && a.counterparty !== 'contract';

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
  const notes = useMemo(() => notesByTx(report), [report]);
  // Transfers selected to name together.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelected = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
      <ContactNameOptions report={report} />
      {selected.size > 0 && (
        <BulkNameBar
          targets={report.activity
            .filter((a) => selected.has(flagKey(a.chain, a.txHash)))
            .map((a) => ({ kind: 'tx' as const, chain: a.chain, ref: a.txHash }))}
          report={report}
          onDone={() => setSelected(new Set())}
        />
      )}
      <ul className="divide-y divide-gray-800/70">
        {rows.slice(0, limit).map((a) => {
          const key = `${a.chain}:${a.txHash}`;
          const note = notes.get(flagKey(a.chain, a.txHash));
          return (
            <li key={key} className="py-3">
              <ActivityRow
                a={a}
                flagged={flags.has(flagKey(a.chain, a.txHash))}
                report={report}
                note={note}
                selected={selected.has(flagKey(a.chain, a.txHash))}
                onSelect={() => toggleSelected(flagKey(a.chain, a.txHash))}
                showWallet={multiWallet}
                onLink={() => setLinking(linking === key ? null : key)}
                linkOpen={linking === key}
                detailsOpen={open === key}
                onDetails={() => setOpen(open === key ? null : key)}
              />
              {note && open !== key && (
                <p className="ml-36 mt-1 whitespace-pre-wrap text-xs italic text-amber-200/90">
                  📝 {note.note}
                </p>
              )}
              {open === key && (
                <TxDetails a={a} flag={flags.get(flagKey(a.chain, a.txHash))} note={note} />
              )}
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
  report,
  note,
  selected,
  onSelect,
  showWallet,
  onLink,
  linkOpen,
  detailsOpen,
  onDetails,
}: {
  a: CashflowActivity;
  flagged: boolean;
  report: CashflowReport;
  note: CashflowTxNote | undefined;
  selected: boolean;
  onSelect: () => void;
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
  const linked = a.linkedTxs ?? (a.linkedTo ? [a.linkedTo] : []);
  const isBridge = a.type === 'bridge';
  // A paired bridge can be pointed at a different transaction when it was matched wrong.
  const relinkable = isBridge && a.linkSide !== null && linked.length > 0;
  const linkable =
    OUTGOING.includes(a.type) ||
    INCOMING.includes(a.type) ||
    unpaid ||
    unsold ||
    tradePayment ||
    relinkable;

  const unlink = () => {
    if (linked.length === 0) return;
    // Always record a rejection (the API drops any manual link for the pair
    // first). Just deleting a manual link would let the automatic matcher
    // pair the same two transactions straight back up.
    void run('Unlinked — counted as separate transfers again', async (token, view) => {
      let last: CashflowResponse | null = null;
      for (const pair of linkedPairs(a))
        last = await addCashflowLink(token, { kind: 'unlink', ...pair }, view);
      return last!;
    });
  };

  // Naming the person on the other side: this transfer, or everything with its address.
  const [editing, setEditing] = useState<'name' | 'addressName' | 'note' | null>(null);
  const personal = nameable(a);
  const own = personal ? findContactLabel(report, 'tx', a.chain, a.txHash) : undefined;
  const sharedExchangeWallet =
    personal &&
    report.counterparties.some(
      (c) =>
        c.exchangeSource === 'known' &&
        c.chain === a.chain &&
        c.address.toLowerCase() === a.counterparty!.toLowerCase(),
    );
  const addressLabel =
    personal && !sharedExchangeWallet
      ? findContactLabel(report, 'address', a.chain, a.counterparty!)
      : undefined;
  const removeName = (id: string) =>
    void run('Name removed', (token, view) => removeCashflowContactLabel(token, id, view));
  const lostItem = useLostMenuItem(report);
  const menu: MenuItem[] = personal
    ? [
        ...contactMenuItems(own, 'tx', () => setEditing('name'), removeName, addressLabel?.label),
        // An exchange's public wallet is shared by all its customers: only single transfers get a name.
        ...(sharedExchangeWallet
          ? []
          : [
              addressLabel
                ? {
                    label: `Rename the address’s “${addressLabel.label}”…`,
                    onSelect: () => setEditing('addressName'),
                  }
                : {
                    label: 'Name who this address is…',
                    title: 'Applies to every transfer with this address',
                    onSelect: () => setEditing('addressName'),
                  },
            ]),
        { label: note ? 'Edit note…' : 'Add note…', onSelect: () => setEditing('note') },
      ]
    : [];
  // Sent away and never coming back (e.g. a locked escrow): book its cost as a loss.
  if (a.type === 'sent_asset') menu.push(lostItem(a.chain, a.txHash));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="w-4 shrink-0 self-start pt-0.5">
          {personal && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelect}
              aria-label="Select to name with others"
            />
          )}
        </div>
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
            {own ? (
              <ContactChip name={own.label} />
            ) : addressLabel ? (
              <ContactChip name={addressLabel.label} inherited />
            ) : null}
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
                  : relinkable
                    ? 'Change link…'
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
        <div className="w-6 shrink-0 self-start text-right">
          <RowMenu items={menu} label="Transfer actions" />
        </div>
      </div>
      {editing && (
        <div className="ml-36">
          {editing === 'note' ? (
            <NoteEditor
              chain={a.chain}
              txHash={a.txHash}
              initial={note?.note ?? ''}
              onDone={() => setEditing(null)}
            />
          ) : editing === 'name' ? (
            <ContactNameEditor
              kind="tx"
              chain={a.chain}
              refValue={a.txHash}
              initial={own?.label ?? addressLabel?.label ?? ''}
              onDone={() => setEditing(null)}
            />
          ) : (
            <ContactNameEditor
              kind="address"
              chain={a.chain}
              refValue={a.counterparty!}
              initial={addressLabel?.label ?? ''}
              onDone={() => setEditing(null)}
            />
          )}
        </div>
      )}
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
function TxDetails({
  a,
  flag,
  note,
}: {
  a: CashflowActivity;
  flag: CashflowFlag | undefined;
  note: CashflowTxNote | undefined;
}) {
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
      <div className="mt-2">
        <TxNoteControl
          key={note?.updatedAt ?? 'none'}
          chain={a.chain}
          txHash={a.txHash}
          note={note}
        />
      </div>
      <FlagControl chain={a.chain} txHash={a.txHash} flag={flag} />
    </div>
  );
}

/** Money value of a transfer row, without the gas. */
const moneyOf = (a: CashflowActivity) =>
  // A paired bridge books only its fee; what it moved is in its legs.
  a.type === 'bridge'
    ? a.legs.reduce((sum, l) => sum + (l.usd ?? 0), 0)
    : OUTGOING.includes(a.type)
      ? a.outUsd - a.feeUsd
      : a.inUsd;

/** The saved-link pairs (from → to) a linked row is part of, for unlinking it. */
function linkedPairs(a: CashflowActivity) {
  const linked = a.linkedTxs ?? (a.linkedTo ? [a.linkedTo] : []);
  return linked.map((other) =>
    a.linkSide === 'out'
      ? { fromChain: a.chain, fromTxHash: a.txHash, toChain: other.chain, toTxHash: other.txHash }
      : { fromChain: other.chain, fromTxHash: other.txHash, toChain: a.chain, toTxHash: a.txHash },
  );
}

/** Which way money went: a paired bridge keeps the side it was on. */
const isOutgoing = (a: CashflowActivity) =>
  OUTGOING.includes(a.type) || (a.type === 'bridge' && a.linkSide === 'out');

/** " to AbCd…x9JZ (Bob)" — who the other side of a candidate transaction was. */
function PartyNote({ a, report }: { a: CashflowActivity; report: CashflowReport }) {
  const party = a.counterparty;
  if (!party || party === 'contract') return null;
  const out = OUTGOING.includes(a.type) || a.type === 'sent_asset' || a.type === 'trade_payment';
  const name =
    findContactLabel(report, 'tx', a.chain, a.txHash)?.label ??
    findContactLabel(report, 'address', a.chain, party)?.label ??
    (a.exchange ? `${a.exchange}` : null);
  return (
    <span className="text-gray-400">
      {out ? ' to ' : ' from '}
      <span className="font-mono" title={party}>
        {party.length > 16 ? truncateAddress(party) : party}
      </span>
      {name && <span className="text-sky-300/90"> ({name})</span>}
    </span>
  );
}

const SHAPES: Record<CashflowTxShape, string> = {
  payment: 'a payment',
  receipt: 'money received',
  money_both_ways: 'money going both ways',
  arrival: 'something arriving with no payment',
  departure: 'something leaving with no payment',
  swap: 'a swap',
  trade: 'a trade that already has its money',
  nothing: 'a transaction that moved nothing of yours',
};

/** Why a saved link wasn't applied, in plain words. */
export function linkIssueMessage(i: CashflowLinkIssue): string {
  if (i.reason === 'not_found')
    return `Saved, but not applied: ${i.missing === 'both' ? 'neither transaction is' : "that transaction isn't"} in the scanned history of your linked wallets. It has to be one of your wallets' own transactions — if it was sent from another wallet, add that wallet (watch-only) first; if it's newer than your last scan, fetch new activity.`;
  if (i.reason === 'already_linked')
    return 'Saved, but not applied: one of these is already part of another link (a bridge, or another trade). Unlink that one first, then link these again.';
  return `Saved, but not applied: that pairs ${SHAPES[i.fromKind ?? 'nothing']} with ${SHAPES[i.toKind ?? 'nothing']}. A link needs a payment and what it paid for (something arriving with no payment), or something sent and the money received for it.`;
}

const sameTx = (chain: string, hash: string, c2: string, h2: string) =>
  chain === c2 && (chain === 'solana' ? hash === h2 : hash.toLowerCase() === h2.toLowerCase());

/**
 * Every link you've saved on this transaction — applied or not — so a wrong
 * guess can be removed even when it never showed up anywhere.
 */
function SavedLinks({ source, report }: { source: CashflowActivity; report: CashflowReport }) {
  const { run, busy } = useCashflowActions();
  const saved = report.links.filter(
    (l) =>
      l.kind === 'link' &&
      (sameTx(l.fromChain, l.fromTxHash, source.chain, source.txHash) ||
        sameTx(l.toChain, l.toTxHash, source.chain, source.txHash)),
  );
  if (saved.length === 0) return null;
  return (
    <div className="mb-3 rounded-md border border-gray-800 px-2 py-1.5 text-xs">
      <div className="mb-1 text-gray-400">Links you've saved on this transaction</div>
      <ul className="space-y-1">
        {saved.map((l) => {
          const fromSide = sameTx(l.fromChain, l.fromTxHash, source.chain, source.txHash);
          const chain = fromSide ? l.toChain : l.fromChain;
          const hash = fromSide ? l.toTxHash : l.fromTxHash;
          const other = report.activity.find((a) => sameTx(a.chain, a.txHash, chain, hash));
          const issue = report.linkIssues.find(
            (i) =>
              sameTx(i.fromChain, i.fromTxHash, l.fromChain, l.fromTxHash) &&
              sameTx(i.toChain, i.toTxHash, l.toChain, l.toTxHash),
          );
          const url = txExplorerUrl(chain, hash);
          return (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-gray-200">
                <span className="text-gray-500">{CHAIN_LABELS[chain] ?? chain} · </span>
                {other ? (
                  other.label
                ) : (
                  <span className="font-mono">{truncateAddress(hash, 8)}</span>
                )}
                {other && <PartyNote a={other} report={report} />}
              </span>
              {url && (
                <ExplorerIcon url={url} label={`Open this transaction on ${explorerName(chain)}`} />
              )}
              {issue ? (
                <span className="cursor-help text-amber-300/90" title={linkIssueMessage(issue)}>
                  not applied
                </span>
              ) : (
                <span className="text-emerald-300/90">applied</span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run('Link removed', (tk, view) => removeCashflowLink(tk, l.id, view))
                }
                className="text-red-300 hover:text-red-200 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Transfers smaller than this are hidden from the candidates unless asked for (dust, spam, rent). */
const SMALL_USD = 5;

const DAY_MS = 86_400_000;
const LINK_RANGES = {
  week: { label: 'Within a week', ms: 7 * DAY_MS },
  month: { label: 'Within a month', ms: 31 * DAY_MS },
  quarter: { label: 'Within 3 months', ms: 92 * DAY_MS },
  year: { label: 'Within a year', ms: 366 * DAY_MS },
  all: { label: 'Any time', ms: Number.POSITIVE_INFINITY },
} as const;

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
  const sourceIsOut = isOutgoing(source);
  // Re-pointing a bridge that was matched to the wrong transaction.
  const relinking = source.type === 'bridge';
  const currentPartners = new Set(
    (source.linkedTxs ?? (source.linkedTo ? [source.linkedTo] : [])).map(
      (t) => `${t.chain}:${t.txHash.toLowerCase()}`,
    ),
  );
  const assetSource = source.type === 'received_asset' || source.type === 'sent_asset';
  const [manualChain, setManualChain] = useState(
    assetSource ? source.chain : source.chain === 'solana' ? 'ethereum' : 'solana',
  );
  const [manualHash, setManualHash] = useState('');
  // How far from this one to look — a presale can be paid weeks before the airdrop.
  const [range, setRange] = useState<keyof typeof LINK_RANGES>('week');
  const [query, setQuery] = useState('');
  const [showSmall, setShowSmall] = useState(false);

  // Likely other halves in range (same person first, then closest in value,
  // then in time), listed by date.
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
              ? // A bridge arrival already (wrongly) paired with something else can be taken over.
                [...INCOMING, 'received_asset', 'bridge']
              : [...OUTGOING, 'sent_asset', 'bridge'];
    const t0 = new Date(source.timestamp).getTime();
    const value = moneyOf(source);
    const party = source.counterparty?.toLowerCase() ?? null;
    return (
      report.activity
        .filter(
          (b) =>
            partnerTypes.includes(b.type) &&
            b !== source &&
            // Only the other side of a bridge, and not the one it's already paired with.
            (b.type !== 'bridge' ||
              (b.linkSide !== null &&
                isOutgoing(b) !== sourceIsOut &&
                !currentPartners.has(`${b.chain}:${b.txHash.toLowerCase()}`))),
        )
        .map((b) => ({
          b,
          dt: new Date(b.timestamp).getTime() - t0,
          ratio: value > 0 ? moneyOf(b) / value : 0,
          samePerson: !!party && b.counterparty?.toLowerCase() === party,
        }))
        .filter(({ b, dt }) => {
          const span = LINK_RANGES[range].ms;
          // Trades can come in either order; a bridge arrives after it leaves.
          const inRange =
            assetSource || b.type === 'received_asset' || b.type === 'sent_asset'
              ? Math.abs(dt) < span
              : sourceIsOut
                ? dt > -10 * 60_000 && dt < span
                : dt < 10 * 60_000 && dt > -span;
          if (!inRange) return false;
          // Dust and spam crowd out the real candidates.
          const assetTx = b.type === 'received_asset' || b.type === 'sent_asset';
          if (!showSmall && !assetTx && moneyOf(b) < SMALL_USD) return false;
          const q = query.trim().toLowerCase();
          return (
            !q ||
            b.label.toLowerCase().includes(q) ||
            (b.counterparty ?? '').toLowerCase().includes(q) ||
            (findContactLabel(report, 'address', b.chain, b.counterparty ?? '')?.label ?? '')
              .toLowerCase()
              .includes(q) ||
            b.txHash.toLowerCase().includes(q)
          );
        })
        .sort(
          (x, y) =>
            Number(y.samePerson) - Number(x.samePerson) ||
            // Nothing to compare against (an airdrop has no value): bigger payments first.
            (value > 0
              ? Math.abs(1 - x.ratio) - Math.abs(1 - y.ratio)
              : moneyOf(y.b) - moneyOf(x.b)) ||
            Math.abs(x.dt) - Math.abs(y.dt),
        )
        .slice(0, range === 'week' ? 12 : 40)
        // The likeliest ones make the list; they're shown in date order.
        .sort((x, y) => x.dt - y.dt)
    );
  }, [report, source, sourceIsOut, assetSource, range, query, showSmall]);

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
          : relinking
            ? 'Link changed'
            : others.length > 1
              ? `Linked ${others.length} transactions as one trade`
              : 'Linked',
      async (token, view) => {
        let last: CashflowResponse | null = null;
        // Reject the wrong pairings first — this bridge's, and any the picked
        // transactions are in — so neither the matcher nor Relay's records
        // pair them back up, and a saved link doesn't block the new one.
        const stale = [
          source,
          ...others.map((o) =>
            report.activity.find((b) => sameTx(b.chain, b.txHash, o.chain, o.txHash)),
          ),
        ]
          .filter((b): b is CashflowActivity => !!b && b.type === 'bridge')
          .flatMap(linkedPairs);
        for (const pair of stale)
          last = await addCashflowLink(token, { kind: 'unlink', ...pair }, view);
        for (const o of others)
          last = await addCashflowLink(token, { kind: 'link', ...pairFor(o) }, view);
        return last!;
      },
      (response) => {
        if (response.status !== 'ready') return null;
        const key = (c1: string, h1: string, c2: string, h2: string) =>
          `${c1}:${h1.toLowerCase()}>${c2}:${h2.toLowerCase()}`;
        const pairs = new Set(
          others.map((o) => {
            const p = pairFor(o);
            return key(p.fromChain, p.fromTxHash, p.toChain, p.toTxHash);
          }),
        );
        const issue = response.report.linkIssues.find((i) =>
          pairs.has(key(i.fromChain, i.fromTxHash, i.toChain, i.toTxHash)),
        );
        return issue ? linkIssueMessage(issue) : null;
      },
    ).then((ok) => ok && onDone());
  };

  return (
    <div className="mt-3 rounded-lg border border-gray-800 bg-gray-900/40 p-3 text-sm">
      <div className="mb-2 text-xs text-gray-400">
        {relinking
          ? 'Matched to the wrong transaction? Pick the right one — the current match is undone.'
          : source.type === 'received_asset'
            ? 'Paid for separately — a presale, an OTC deal, or a cross-chain (Relay) mint? Pick the payment.'
            : source.type === 'sent_asset'
              ? 'Sold this in an OTC deal? Pick the payment you received for it.'
              : sourceIsOut
                ? 'Where did this money arrive — or what did it pay for (OTC deal, cross-chain mint)?'
                : 'Where did this money come from — or what did you sell for it?'}
      </div>
      <SavedLinks source={source} report={report} />
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <label className="text-gray-500" htmlFor={`link-range-${source.txHash}`}>
          Look
        </label>
        <select
          id={`link-range-${source.txHash}`}
          value={range}
          onChange={(e) => setRange(e.target.value as keyof typeof LINK_RANGES)}
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 text-gray-200"
        >
          {Object.entries(LINK_RANGES).map(([id, r]) => (
            <option key={id} value={id}>
              {r.label}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter: amount, address, tx…"
          aria-label="Filter transactions"
          className="w-52 rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 text-gray-200"
        />
        <label className="flex items-center gap-1.5 text-gray-400">
          <input
            type="checkbox"
            checked={showSmall}
            onChange={(e) => setShowSmall(e.target.checked)}
          />
          Include transfers under ${SMALL_USD}
        </label>
      </div>
      {candidates.length > 0 ? (
        <>
          <ul className="max-h-80 space-y-1 overflow-y-auto">
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
                      <PartyNote a={b} report={report} />
                    </span>
                    {txExplorerUrl(b.chain, b.txHash) && (
                      <ExplorerIcon
                        url={txExplorerUrl(b.chain, b.txHash)!}
                        label={`Open this transaction on ${explorerName(b.chain)}`}
                      />
                    )}
                    <span className="shrink-0 text-xs tabular-nums text-gray-400">
                      {usd(moneyOf(b))} ·{' '}
                      <span
                        className="cursor-help underline decoration-dotted decoration-gray-600 underline-offset-2"
                        title={new Date(b.timestamp).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'medium',
                        })}
                      >
                        {formatGap(dt)}
                      </span>
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
            transactions, or a presale paid once and airdropped in unlocks. The money is split
            across them (by number of NFTs, or by amount of one token) and counted once.
          </p>
        </>
      ) : (
        <p className="text-xs text-gray-500">
          Nothing {LINK_RANGES[range].label.toLowerCase()}
          {query.trim() ? ' matching that' : ''} — look further, or paste the transaction below.
        </p>
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
