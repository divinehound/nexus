'use client';

import { Fragment, useMemo, useState } from 'react';
import type { CashflowContact, CashflowCounterparty, CashflowReport } from '@nexus/types';
import {
  addCashflowAddressTag,
  addWatchedWallet,
  getMyCashflow,
  removeCashflowAddressTag,
  removeCashflowContactLabel,
} from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { IN_COLOR, OUT_COLOR } from './cashflow-chart';
import { CHAIN_LABELS, addressExplorerUrl, explorerName, pnlClass, usd, usdSigned } from './format';
import {
  ContactChip,
  ContactNameEditor,
  ContactNameOptions,
  RowMenu,
  TransfersTable,
  contactMenuItems,
  findContactLabel,
  type MenuItem,
  notesByTx,
  type TransferRow,
} from './labels';
import { flagKey } from './flags';
import { ExplorerIcon, Stat } from './ui';

const SOURCE_LABELS = {
  known: 'exchange wallet',
  detected: 'your deposit address',
  tagged: 'tagged by you',
} as const;

export function CounterpartiesTable({ report }: { report: CashflowReport }) {
  const people = report.counterparties.filter((c) => !c.exchange);
  const sent = people.reduce((s, c) => s + c.sentUsd, 0);
  const received = people.reduce((s, c) => s + c.receivedUsd, 0);
  const cashedOut = report.exchanges.reduce((s, e) => s + e.depositedUsd, 0);
  const deposited = report.exchanges.reduce((s, e) => s + e.withdrawnUsd, 0);
  const [openExchange, setOpenExchange] = useState<string | null>(null);
  const allTransfers = useMemo<TransferRow[]>(
    () => [
      ...report.counterparties.flatMap((c) =>
        c.transfers.map((t) => ({ ...t, address: c.address })),
      ),
      ...(report.otherTransfers ?? []),
    ],
    [report.counterparties, report.otherTransfers],
  );
  const [view, setView] = useState<'grouped' | 'dated'>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'dated' ? 'dated' : 'grouped';
    } catch {
      return 'grouped';
    }
  });
  const pickView = (v: 'grouped' | 'dated') => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Remembering the choice is a nicety.
    }
  };

  const viewToggle = (
    <div className="flex gap-1 text-xs" role="group" aria-label="View">
      {(
        [
          ['grouped', 'By person & address'],
          ['dated', 'Every transfer by date'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-pressed={view === id}
          onClick={() => pickView(id)}
          className={cn(
            'rounded-md px-2 py-1',
            view === id
              ? 'bg-purple-600/30 text-purple-200'
              : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (view === 'dated') {
    return (
      <div className="space-y-4">
        <ContactNameOptions report={report} />
        {viewToggle}
        <AllTransfers report={report} transfers={allTransfers} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ContactNameOptions report={report} />
      {viewToggle}
      <PeopleTable report={report} transfers={allTransfers} />

      <div>
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Exchanges</h3>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Deposited from exchanges" value={usd(deposited)} swatch={IN_COLOR} />
          <Stat label="Cashed out to exchanges" value={usd(cashedOut)} swatch={OUT_COLOR} />
          <Stat
            label="Net invested"
            value={usdSigned(report.totals.netInvestedUsd)}
            sub="deposited − cashed out: your own money still in crypto"
          />
        </div>
        {report.exchanges.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-gray-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Exchange</th>
                  <th className="py-2 pr-4 text-right font-medium">Deposited into crypto</th>
                  <th className="py-2 pr-4 text-right font-medium">Cashed out</th>
                  <th className="py-2 text-right font-medium">Net invested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/70">
                {report.exchanges.map((e) => (
                  <Fragment key={e.exchange}>
                    <tr>
                      <td className="py-2 pr-4">
                        <ExpandableName
                          open={openExchange === e.exchange}
                          onToggle={() =>
                            setOpenExchange(openExchange === e.exchange ? null : e.exchange)
                          }
                          name={<span className="font-medium text-gray-200">{e.exchange}</span>}
                          what={`${e.txCount} transfer${e.txCount === 1 ? '' : 's'}`}
                        />
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(e.withdrawnUsd)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{usd(e.depositedUsd)}</td>
                      <td className="py-2 text-right tabular-nums text-gray-200">
                        {usdSigned(e.withdrawnUsd - e.depositedUsd)}
                      </td>
                    </tr>
                    {openExchange === e.exchange && (
                      <tr>
                        <td colSpan={4} className="pb-3">
                          <TransfersTable
                            rows={allTransfers.filter((t) => t.exchange === e.exchange)}
                            report={report}
                            showAddress
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            No exchange transfers recognised. If you sent money to your Coinbase, Kraken or other
            exchange account, mark that address below.
          </p>
        )}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Other wallets</h3>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Sent to other wallets" value={usd(sent)} swatch={OUT_COLOR} />
          <Stat label="Received from other wallets" value={usd(received)} swatch={IN_COLOR} />
          <Stat
            label="Moved between your wallets"
            value={`${report.ownWalletTransfers.count} tx · ${usd(report.ownWalletTransfers.usd)}`}
          />
          <Stat
            label="Bridged between chains"
            value={`${report.bridges.count} tx · ${usd(report.bridges.usd)}`}
          />
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Plain transfers of ETH/SOL/POL/APE and stablecoins. Moves between your own linked wallets
          — on the same chain or bridged — aren&apos;t counted as money in or out; only gas and what
          the bridge kept count as fees
          {report.bridges.feesUsd > 0 ? ` (${usd(report.bridges.feesUsd)} in bridge fees)` : ''}.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Address</th>
                <th className="py-2 pr-4 text-right font-medium">Sent to</th>
                <th className="py-2 pr-4 text-right font-medium">Received from</th>
                <th className="py-2 pr-4 text-right font-medium">Net</th>
                <th className="py-2 text-right font-medium">Last</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/70">
              {report.counterparties.map((c) => (
                <CounterpartyRow key={`${c.chain}:${c.address}`} c={c} report={report} />
              ))}
              {report.counterparties.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-gray-500">
                    No transfers to or from other wallets.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const VIEW_KEY = 'money.transfers.view';

type DirFilter = 'all' | 'in' | 'out';
type KindFilter = 'all' | 'exchange' | 'wallet' | 'named' | 'unnamed';
type TransferSort = 'newest' | 'oldest' | 'largest' | 'smallest';
const KIND_FILTERS: Array<[KindFilter, string]> = [
  ['all', 'All'],
  ['exchange', 'Exchanges'],
  ['wallet', 'Other wallets'],
  ['named', 'Named'],
  ['unnamed', 'Not named'],
];

/** Every transfer in one list — filter, search and sort them, with totals for what's shown. */
function AllTransfers({ report, transfers }: { report: CashflowReport; transfers: TransferRow[] }) {
  const [query, setQuery] = useState('');
  const [dir, setDir] = useState<DirFilter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [chain, setChain] = useState('');
  const [sort, setSort] = useState<TransferSort>('newest');
  // Dust (address-poisoning spam, rounding leftovers) buries the real transfers.
  const [hideSmall, setHideSmall] = useState(true);
  const notes = useMemo(() => notesByTx(report), [report]);
  const chains = useMemo(() => [...new Set(transfers.map((t) => t.chain))].sort(), [transfers]);

  const { rows, small } = useMemo(() => {
    const q = query.trim().toLowerCase();
    let small = 0;
    const list = transfers.filter((t) => {
      if (dir !== 'all' && t.direction !== dir) return false;
      if (kind === 'exchange' && !t.exchange) return false;
      if (kind === 'wallet' && t.exchange) return false;
      if (kind === 'named' && !t.contact) return false;
      if (kind === 'unnamed' && t.contact) return false;
      if (chain && t.chain !== chain) return false;
      if (q) {
        const note = notes.get(flagKey(t.chain, t.txHash))?.note ?? '';
        const hay = [
          t.address,
          t.txHash,
          t.contact,
          t.exchange,
          t.symbol,
          note,
          CHAIN_LABELS[t.chain],
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (hideSmall && t.usd < SMALL_USD) {
        small++;
        return false;
      }
      return true;
    });
    const by: Record<TransferSort, (a: TransferRow, b: TransferRow) => number> = {
      newest: (a, b) => b.at.localeCompare(a.at),
      oldest: (a, b) => a.at.localeCompare(b.at),
      largest: (a, b) => b.usd - a.usd || b.at.localeCompare(a.at),
      smallest: (a, b) => a.usd - b.usd || b.at.localeCompare(a.at),
    };
    return { rows: list.sort(by[sort]), small };
  }, [transfers, query, dir, kind, chain, sort, hideSmall, notes]);

  const inUsd = rows.filter((t) => t.direction === 'in').reduce((s, t) => s + t.usd, 0);
  const outUsd = rows.filter((t) => t.direction === 'out').reduce((s, t) => s + t.usd, 0);
  const chip = (active: boolean) =>
    cn(
      'rounded-md px-2 py-1',
      active
        ? 'bg-purple-600/30 text-purple-200'
        : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200',
    );

  return (
    <div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Transfers shown" value={rows.length.toLocaleString()} />
        <Stat label="Received" value={usd(inUsd)} swatch={IN_COLOR} />
        <Stat label="Sent" value={usd(outUsd)} swatch={OUT_COLOR} />
        <Stat label="Net" value={usdSigned(inUsd - outUsd)} valueClass={pnlClass(inUsd - outUsd)} />
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search address, name, exchange, note, tx…"
          aria-label="Search transfers"
          className="w-full rounded-md border border-gray-700 bg-gray-900 px-2.5 py-1.5 text-sm text-gray-200 placeholder:text-gray-500 focus:border-purple-500 focus:outline-none sm:w-72"
        />
        <div className="flex gap-1" role="group" aria-label="Direction">
          {(
            [
              ['all', 'In & out'],
              ['in', 'Received'],
              ['out', 'Sent'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={dir === id}
              onClick={() => setDir(id)}
              className={chip(dir === id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Kind">
          {KIND_FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={kind === id}
              onClick={() => setKind(id)}
              className={chip(kind === id)}
            >
              {label}
            </button>
          ))}
        </div>
        {chains.length > 1 && (
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            aria-label="Chain"
            className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-200"
          >
            <option value="">All chains</option>
            {chains.map((c) => (
              <option key={c} value={c}>
                {CHAIN_LABELS[c] ?? c}
              </option>
            ))}
          </select>
        )}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as TransferSort)}
          aria-label="Sort"
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-gray-200"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="largest">Largest first</option>
          <option value="smallest">Smallest first</option>
        </select>
        <label className="inline-flex items-center gap-1.5 text-gray-400">
          <input
            type="checkbox"
            checked={hideSmall}
            onChange={(e) => setHideSmall(e.target.checked)}
          />
          Hide under {usd(SMALL_USD)}
          {hideSmall && small > 0 && <span className="text-gray-500">({small} hidden)</span>}
        </label>
      </div>
      <TransfersTable rows={rows} report={report} showAddress presorted />
    </div>
  );
}

/** Transfers worth less than this are dust — hidden unless asked. */
const SMALL_USD = 1;

/** An address that can carry a person's name: not unknown, not an exchange's shared public wallet. */
const isNameable = (c: CashflowCounterparty) =>
  c.address !== 'unknown' && c.exchangeSource !== 'known';

function CounterpartyRow({ c, report }: { c: CashflowCounterparty; report: CashflowReport }) {
  const { run, busy } = useCashflowActions();
  const [editing, setEditing] = useState<'name' | 'tag' | null>(null);
  const [exchange, setExchange] = useState(report.exchangeNames[0] ?? 'Coinbase');
  const url = addressExplorerUrl(c.chain, c.address);
  const family = c.chain === 'solana' ? 'solana' : 'evm';
  const tag = report.addressTags.find(
    (t) =>
      t.chainFamily === family &&
      (family === 'solana' ? t.address === c.address : t.address === c.address.toLowerCase()),
  );
  const canTag = c.address !== 'unknown';
  const [open, setOpen] = useState(false);
  const nameLabel = canTag ? findContactLabel(report, 'address', c.chain, c.address) : undefined;
  const own = report.wallets.some((w) =>
    family === 'solana'
      ? w.address === c.address
      : w.address.toLowerCase() === c.address.toLowerCase(),
  );
  // An exchange's public wallet is shared by all its customers; your own tagged exchange account isn't a wallet you hold.
  const canWatch = canTag && !own && c.exchangeSource !== 'known' && !tag;
  const count = c.sentCount + c.receivedCount;

  const addWatched = () => {
    if (
      !window.confirm(
        `Add ${truncateAddress(c.address)} as one of your wallets (watch-only)? It will be scanned and counted as part of your portfolio.`,
      )
    )
      return;
    void run('Added as your watch-only wallet — scanning it now', async (token, view) => {
      await addWatchedWallet(token, {
        family,
        address: c.address,
        label: nameLabel?.label ?? undefined,
      });
      return getMyCashflow(token, false, view);
    });
  };
  // An exchange's public wallet is shared by all its customers: no names or tags on it, only per transfer.
  const personal = isNameable(c);
  const items: MenuItem[] = [
    ...(personal
      ? contactMenuItems(
          nameLabel,
          'address',
          () => setEditing('name'),
          (id) =>
            void run('Name removed', (token, view) => removeCashflowContactLabel(token, id, view)),
        )
      : []),
    ...(tag
      ? [
          {
            label: 'Remove exchange tag',
            danger: true,
            onSelect: () =>
              void run('Tag removed', (token, view) =>
                removeCashflowAddressTag(token, tag.id, view),
              ),
          },
        ]
      : personal
        ? [
            {
              label: c.exchange ? 'Wrong exchange? Retag…' : 'This is my exchange account…',
              onSelect: () => setEditing('tag'),
            },
          ]
        : []),
    ...(canWatch
      ? [
          {
            label: 'This is my wallet (watch-only)…',
            title:
              "Counts it as yours (moves to/from it aren't spending) and scans it for its own trades. It can't be used to sign in.",
            onSelect: addWatched,
          },
        ]
      : []),
  ];

  return (
    <Fragment>
      <tr className="align-top">
        <td className="py-2 pr-4">
          <ExpandableName
            open={open}
            onToggle={() => setOpen(!open)}
            name={
              <span className="font-mono text-gray-200">
                {c.address.length > 16 ? truncateAddress(c.address) : c.address}
              </span>
            }
            after={
              <>
                {url && canTag && (
                  <ExplorerIcon url={url} label={`View this address on ${explorerName(c.chain)}`} />
                )}
                <RowMenu items={items} label="Address actions" />
              </>
            }
            sub={CHAIN_LABELS[c.chain] ?? c.chain}
            what={count > 0 ? `${count} transfer${count === 1 ? '' : 's'}` : null}
          />
          {(nameLabel || c.exchange) && (
            <div className="ml-[1.1rem] mt-1 flex flex-wrap items-center gap-2 text-xs">
              {nameLabel && <ContactChip name={nameLabel.label} />}
              {c.exchange && (
                <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-purple-200">
                  {c.exchange} · {c.exchangeSource ? SOURCE_LABELS[c.exchangeSource] : ''}
                </span>
              )}
            </div>
          )}
          {editing === 'name' && (
            <ContactNameEditor
              kind="address"
              chain={c.chain}
              refValue={c.address}
              initial={nameLabel?.label ?? ''}
              onDone={() => setEditing(null)}
            />
          )}
          {editing === 'tag' && (
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(`Marked as your ${exchange} account`, (token, view) =>
                  addCashflowAddressTag(
                    token,
                    { chain: c.chain, address: c.address, exchange },
                    view,
                  ),
                ).then((ok) => ok && setEditing(null));
              }}
            >
              <select
                value={exchange}
                onChange={(e) => setExchange(e.target.value)}
                aria-label="Exchange"
                className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
              >
                {report.exchangeNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-purple-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="text-xs text-gray-400 hover:text-white"
              >
                Cancel
              </button>
            </form>
          )}
        </td>
        <td className="py-2 pr-4 text-right tabular-nums">
          {c.sentUsd ? usd(c.sentUsd) : '—'}
          {c.sentCount > 0 && <div className="text-xs text-gray-500">{c.sentCount}×</div>}
        </td>
        <td className="py-2 pr-4 text-right tabular-nums">
          {c.receivedUsd ? usd(c.receivedUsd) : '—'}
          {c.receivedCount > 0 && <div className="text-xs text-gray-500">{c.receivedCount}×</div>}
        </td>
        <td
          className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(c.receivedUsd - c.sentUsd))}
        >
          {usdSigned(c.receivedUsd - c.sentUsd)}
        </td>
        <td className="py-2 text-right text-xs text-gray-500">
          {new Date(c.lastAt).toLocaleDateString()}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="pb-3">
            <TransfersTable
              rows={c.transfers.map((t) => ({ ...t, address: c.address }))}
              report={report}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/**
 * A row's name with its expander in front (▶, as in the collection and token
 * tables); the line under it says what expanding shows.
 */
function ExpandableName({
  open,
  onToggle,
  name,
  after,
  sub,
  what,
}: {
  open: boolean;
  onToggle: () => void;
  name: React.ReactNode;
  /** Icons/menus after the name (outside the toggle). */
  after?: React.ReactNode;
  /** Shown before "show N …" on the second line, e.g. the chain. */
  sub?: React.ReactNode;
  /** What expanding shows, e.g. "6 transfers"; null = nothing to expand. */
  what: string | null;
}) {
  if (!what)
    return (
      <>
        <div className="flex items-center gap-1.5">
          {name}
          {after}
        </div>
        {sub && <div className="text-xs text-gray-500">{sub}</div>}
      </>
    );
  return (
    <>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="group flex items-center gap-1.5 text-left"
        >
          <span
            className={cn('text-xs text-gray-500 transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          >
            ▶
          </span>
          <span className="group-hover:text-purple-300">{name}</span>
        </button>
        {after}
      </div>
      <button
        type="button"
        onClick={onToggle}
        tabIndex={-1}
        className="ml-[1.1rem] block text-left text-xs text-gray-500 hover:text-gray-300"
      >
        {sub && <>{sub} · </>}
        {open ? 'hide' : 'show'} {what}
      </button>
    </>
  );
}

const sameName = (a: string | null, b: string) =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Totals per person you've named, across all their addresses and exchange accounts. */
function PeopleTable({ report, transfers }: { report: CashflowReport; transfers: TransferRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-gray-200">People</h3>
      <p className="mb-3 text-xs text-gray-500">
        Name the person behind an address (below) or behind a single transfer (expand an address or
        exchange). Everything under the same name adds up here — e.g. Bob paying from two wallets
        and his Coinbase account. A transfer from an exchange that you name counts as that
        person&apos;s money, not a withdrawal from your own account.
      </p>
      {report.contacts.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Person</th>
                <th className="py-2 pr-4 text-right font-medium">You sent them</th>
                <th className="py-2 pr-4 text-right font-medium">They sent you</th>
                <th className="py-2 pr-4 text-right font-medium">Net</th>
                <th className="py-2 text-right font-medium">Last</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/70">
              {report.contacts.map((p) => (
                <PersonRow
                  key={p.name}
                  p={p}
                  open={open === p.name}
                  onToggle={() => setOpen(open === p.name ? null : p.name)}
                  rows={transfers.filter((t) => sameName(t.contact, p.name))}
                  report={report}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-gray-500">Nobody named yet.</p>
      )}
    </div>
  );
}

function PersonRow({
  p,
  open,
  onToggle,
  rows,
  report,
}: {
  p: CashflowContact;
  open: boolean;
  onToggle: () => void;
  rows: TransferRow[];
  report: CashflowReport;
}) {
  const net = p.receivedUsd - p.sentUsd;
  return (
    <Fragment>
      <tr className="align-top">
        <td className="py-2 pr-4">
          <ExpandableName
            open={open}
            onToggle={onToggle}
            name={<span className="text-gray-200">👤 {p.name}</span>}
            sub={`${p.addresses.length} address${p.addresses.length === 1 ? '' : 'es'}`}
            what={`${p.sentCount + p.receivedCount} transfer${p.sentCount + p.receivedCount === 1 ? '' : 's'}`}
          />
        </td>
        <td className="py-2 pr-4 text-right tabular-nums">
          {p.sentUsd ? usd(p.sentUsd) : '—'}
          {p.sentCount > 0 && <div className="text-xs text-gray-500">{p.sentCount}×</div>}
        </td>
        <td className="py-2 pr-4 text-right tabular-nums">
          {p.receivedUsd ? usd(p.receivedUsd) : '—'}
          {p.receivedCount > 0 && <div className="text-xs text-gray-500">{p.receivedCount}×</div>}
        </td>
        <td className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(net))}>{usdSigned(net)}</td>
        <td className="py-2 text-right text-xs text-gray-500">
          {new Date(p.lastAt).toLocaleDateString()}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} className="pb-3">
            <TransfersTable rows={rows} report={report} showAddress />
          </td>
        </tr>
      )}
    </Fragment>
  );
}
