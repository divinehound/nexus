'use client';

import { useState } from 'react';
import type { CashflowCounterparty, CashflowReport } from '@nexus/types';
import { addCashflowAddressTag, removeCashflowAddressTag } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { IN_COLOR, OUT_COLOR } from './cashflow-chart';
import { CHAIN_LABELS, addressExplorerUrl, pnlClass, usd, usdSigned } from './format';
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

  return (
    <div className="space-y-6">
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
                  <tr key={e.exchange}>
                    <td className="py-2 pr-4 text-gray-200">
                      {e.exchange}
                      <div className="text-xs text-gray-500">{e.txCount} transfers</div>
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">{usd(e.withdrawnUsd)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{usd(e.depositedUsd)}</td>
                    <td className="py-2 text-right tabular-nums text-gray-200">{usdSigned(e.withdrawnUsd - e.depositedUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            No exchange transfers recognised. If you sent money to your Coinbase, Kraken or other exchange account, mark that
            address below.
          </p>
        )}
      </div>

      <div>
        <h3 className="mb-3 text-sm font-semibold text-gray-200">Other wallets</h3>
        <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Sent to other wallets" value={usd(sent)} swatch={OUT_COLOR} />
          <Stat label="Received from other wallets" value={usd(received)} swatch={IN_COLOR} />
          <Stat label="Moved between your wallets" value={`${report.ownWalletTransfers.count} tx · ${usd(report.ownWalletTransfers.usd)}`} />
          <Stat label="Bridged between chains" value={`${report.bridges.count} tx · ${usd(report.bridges.usd)}`} />
        </div>
        <p className="mb-3 text-xs text-gray-500">
          Plain transfers of ETH/SOL/POL/APE and stablecoins. Moves between your own linked wallets — on the same chain or bridged
          — aren&apos;t counted as money in or out; only gas and what the bridge kept count as fees
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
    (t) => t.chainFamily === family && (family === 'solana' ? t.address === c.address : t.address === c.address.toLowerCase()),
  );
  const canTag = c.address !== 'unknown';

  return (
    <tr className="align-top">
      <td className="py-2 pr-4">
        {url && canTag ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono text-gray-200 hover:text-purple-300">
            {c.address.length > 16 ? truncateAddress(c.address) : c.address}
          </a>
        ) : (
          <span className="font-mono text-gray-200">{c.address}</span>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span>{CHAIN_LABELS[c.chain] ?? c.chain}</span>
          {c.exchange && (
            <span className="rounded bg-purple-500/15 px-1.5 py-0.5 text-purple-200">
              {c.exchange} · {c.exchangeSource ? SOURCE_LABELS[c.exchangeSource] : ''}
            </span>
          )}
          {tag ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('Tag removed', (token) => removeCashflowAddressTag(token, tag.id))}
              className="text-gray-400 hover:text-white disabled:opacity-50"
            >
              Remove tag
            </button>
          ) : (
            canTag &&
            c.exchangeSource !== 'known' &&
            !tagging && (
              <button type="button" onClick={() => setTagging(true)} className="text-purple-300 hover:text-purple-200">
                {c.exchange ? 'Not right?' : 'This is my exchange account'}
              </button>
            )
          )}
        </div>
        {tagging && (
          <form
            className="mt-2 flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(`Marked as your ${exchange} account`, (token) =>
                addCashflowAddressTag(token, { chain: c.chain, address: c.address, exchange }),
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
            <button type="submit" disabled={busy} className="rounded-md bg-purple-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-purple-500 disabled:opacity-50">
              Save
            </button>
            <button type="button" onClick={() => setTagging(false)} className="text-xs text-gray-400 hover:text-white">
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
      <td className={cn('py-2 pr-4 text-right tabular-nums', pnlClass(c.receivedUsd - c.sentUsd))}>{usdSigned(c.receivedUsd - c.sentUsd)}</td>
      <td className="py-2 text-right text-xs text-gray-500">{new Date(c.lastAt).toLocaleDateString()}</td>
    </tr>
  );
}
