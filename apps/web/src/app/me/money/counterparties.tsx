'use client';

import { Fragment, useMemo, useState } from 'react';
import type { CashflowContact, CashflowCounterparty, CashflowReport } from '@nexus/types';
import {
  addCashflowAddressTag,
  addWatchedWallet,
  getMyCashflow,
  removeCashflowAddressTag,
} from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { IN_COLOR, OUT_COLOR } from './cashflow-chart';
import { CHAIN_LABELS, addressExplorerUrl, pnlClass, usd, usdSigned } from './format';
import {
  ContactLabelControl,
  ContactNameOptions,
  TransfersTable,
  findContactLabel,
  type TransferRow,
} from './labels';
import { Stat } from './ui';

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
                      <td className="py-2 pr-4 text-gray-200">
                        {e.exchange}
                        <div>
                          <ExpandButton
                            open={openExchange === e.exchange}
                            onClick={() =>
                              setOpenExchange(openExchange === e.exchange ? null : e.exchange)
                            }
                          >
                            {e.txCount} transfer{e.txCount === 1 ? '' : 's'}
                          </ExpandButton>
                        </div>
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

function CounterpartyRow({ c, report }: { c: CashflowCounterparty; report: CashflowReport }) {
  const { run, busy } = useCashflowActions();
  const [tagging, setTagging] = useState(false);
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

  return (
    <Fragment>
      <tr className="align-top">
        <td className="py-2 pr-4">
          {url && canTag ? (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-gray-200 hover:text-purple-300"
            >
              {c.address.length > 16 ? truncateAddress(c.address) : c.address}
            </a>
          ) : (
            <span className="font-mono text-gray-200">{c.address}</span>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <span>{CHAIN_LABELS[c.chain] ?? c.chain}</span>
            {canTag && c.exchangeSource !== 'known' && (
              <ContactLabelControl
                key={nameLabel?.id ?? 'none'}
                kind="address"
                chain={c.chain}
                refValue={c.address}
                label={nameLabel}
              />
            )}
            {c.exchange && (
              <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-purple-200">
                {c.exchange} · {c.exchangeSource ? SOURCE_LABELS[c.exchangeSource] : ''}
              </span>
            )}
            {tag ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run('Tag removed', (token, view) =>
                    removeCashflowAddressTag(token, tag.id, view),
                  )
                }
                className="text-gray-400 hover:text-white disabled:opacity-50"
              >
                Remove tag
              </button>
            ) : (
              canTag &&
              c.exchangeSource !== 'known' &&
              !tagging && (
                <button
                  type="button"
                  onClick={() => setTagging(true)}
                  className="text-purple-300 hover:text-purple-200"
                >
                  {c.exchange ? 'Not right?' : 'This is my exchange account'}
                </button>
              )
            )}
            {canWatch && (
              <button
                type="button"
                disabled={busy}
                title="Add it as a watch-only wallet: it counts as yours (moves to/from it aren't spending) and is scanned for its own trades. It can't be used to sign in."
                onClick={() => {
                  if (
                    !window.confirm(
                      `Add ${truncateAddress(c.address)} as one of your wallets (watch-only)? It will be scanned and counted as part of your portfolio.`,
                    )
                  )
                    return;
                  void run(
                    'Added as your watch-only wallet — scanning it now',
                    async (token, view) => {
                      await addWatchedWallet(token, {
                        family,
                        address: c.address,
                        label: nameLabel?.label ?? undefined,
                      });
                      return getMyCashflow(token, false, view);
                    },
                  );
                }}
                className="text-emerald-300 hover:text-emerald-200 disabled:opacity-50"
              >
                This is my wallet
              </button>
            )}
          </div>
          {tagging && (
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
                ).then((ok) => ok && setTagging(false));
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
                onClick={() => setTagging(false)}
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
          {count > 0 && (
            <div>
              <ExpandButton open={open} onClick={() => setOpen(!open)}>
                {count} transfer{count === 1 ? '' : 's'}
              </ExpandButton>
            </div>
          )}
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

function ExpandButton({
  open,
  onClick,
  children,
}: {
  open: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className="text-xs text-gray-400 underline-offset-2 hover:text-white hover:underline"
    >
      {open ? '▾' : '▸'} {children}
    </button>
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
          <span className="text-gray-200">👤 {p.name}</span>
          <div className="text-xs text-gray-500">
            <ExpandButton open={open} onClick={onToggle}>
              {p.sentCount + p.receivedCount} transfers · {p.addresses.length} address
              {p.addresses.length === 1 ? '' : 'es'}
            </ExpandButton>
          </div>
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
