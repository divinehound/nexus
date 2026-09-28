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
  BulkNameBar,
  ContactNameOptions,
  RowMenu,
  TransfersTable,
  contactMenuItems,
  findContactLabel,
  type MenuItem,
  type TransferRow,
} from './labels';
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
  // Addresses selected to name together (not exchanges' shared public wallets).
  const [selectedAddrs, setSelectedAddrs] = useState<Set<string>>(new Set());
  const nameable = report.counterparties.filter(isNameable).map((c) => `${c.chain}:${c.address}`);
  const allNameable = nameable.length > 0 && nameable.every((k) => selectedAddrs.has(k));
  const toggleAddr = (key: string) =>
    setSelectedAddrs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allTransfers = useMemo<TransferRow[]>(
    () =>
      report.counterparties.flatMap((c) => c.transfers.map((t) => ({ ...t, address: c.address }))),
    [report.counterparties],
  );

  return (
    <div className="space-y-6">
      <ContactNameOptions report={report} />
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
        {selectedAddrs.size > 0 && (
          <BulkNameBar
            targets={report.counterparties
              .filter((c) => selectedAddrs.has(`${c.chain}:${c.address}`))
              .map((c) => ({ kind: 'address' as const, chain: c.chain, ref: c.address }))}
            report={report}
            onDone={() => setSelectedAddrs(new Set())}
          />
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-gray-500">
              <tr>
                <th className="w-6 py-2 pr-2">
                  <input
                    type="checkbox"
                    checked={allNameable}
                    disabled={nameable.length === 0}
                    onChange={() => setSelectedAddrs(allNameable ? new Set() : new Set(nameable))}
                    aria-label={allNameable ? 'Unselect all' : 'Select all to name them together'}
                    title={allNameable ? 'Unselect all' : 'Select all to name them together'}
                  />
                </th>
                <th className="py-2 pr-4 font-medium">Address</th>
                <th className="py-2 pr-4 text-right font-medium">Sent to</th>
                <th className="py-2 pr-4 text-right font-medium">Received from</th>
                <th className="py-2 pr-4 text-right font-medium">Net</th>
                <th className="py-2 text-right font-medium">Last</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/70">
              {report.counterparties.map((c) => (
                <CounterpartyRow
                  key={`${c.chain}:${c.address}`}
                  c={c}
                  report={report}
                  selected={selectedAddrs.has(`${c.chain}:${c.address}`)}
                  onToggle={() => toggleAddr(`${c.chain}:${c.address}`)}
                />
              ))}
              {report.counterparties.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-gray-500">
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

/** An address that can carry a person's name: not unknown, not an exchange's shared public wallet. */
const isNameable = (c: CashflowCounterparty) =>
  c.address !== 'unknown' && c.exchangeSource !== 'known';

function CounterpartyRow({
  c,
  report,
  selected,
  onToggle,
}: {
  c: CashflowCounterparty;
  report: CashflowReport;
  selected: boolean;
  onToggle: () => void;
}) {
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
      <tr className={cn('align-top', selected && 'bg-purple-500/5')}>
        <td className="py-2 pr-2">
          {personal && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggle}
              aria-label="Select this address"
            />
          )}
        </td>
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
          <td colSpan={6} className="pb-3">
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
