'use client';

import { useState } from 'react';
import type {
  CashflowContactLabel,
  CashflowCounterpartyTransfer,
  CashflowReport,
  CashflowTxNote,
} from '@nexus/types';
import { addCashflowContactLabel, removeCashflowContactLabel, setCashflowTxNote } from '@/lib/api';
import { cn, truncateAddress } from '@/lib/utils';
import { useCashflowActions } from './actions';
import { flagKey } from './flags';
import { CHAIN_LABELS, explorerName, qty, txExplorerUrl, usd } from './format';

/** Notes keyed like flags: EVM hashes are case-insensitive. */
export function notesByTx(report: CashflowReport): Map<string, CashflowTxNote> {
  return new Map(report.txNotes.map((n) => [flagKey(n.chain, n.txHash), n]));
}

/** The user's name on an address (any chain of its family) or on one transfer. */
export function findContactLabel(
  report: CashflowReport,
  kind: 'address' | 'tx',
  chain: string,
  ref: string,
): CashflowContactLabel | undefined {
  const evm = chain !== 'solana';
  const scope = kind === 'address' ? (evm ? 'evm' : 'solana') : chain;
  const want = evm ? ref.toLowerCase() : ref;
  return report.contactLabels.find((l) => l.kind === kind && l.scope === scope && l.ref === want);
}

/** Every name used so far, for suggestions — so "Bob" is typed the same way each time. */
export function contactNames(report: CashflowReport): string[] {
  const seen = new Map<string, string>();
  for (const l of report.contactLabels) {
    const k = l.label.trim().toLowerCase();
    if (!seen.has(k)) seen.set(k, l.label.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export const CONTACT_NAMES_LIST = 'cashflow-contact-names';

/** Put once on the page; name inputs point at it for suggestions. */
export function ContactNameOptions({ report }: { report: CashflowReport }) {
  return (
    <datalist id={CONTACT_NAMES_LIST}>
      {contactNames(report).map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}

/**
 * Names the person behind an address, or behind one transfer. A transfer's
 * own name beats its address's — for someone paying from a shared exchange
 * wallet, or a wallet more than one person used.
 */
export function ContactLabelControl({
  kind,
  chain,
  refValue,
  label,
  inherited,
  compact,
}: {
  kind: 'address' | 'tx';
  chain: string;
  /** The address, or the tx hash. */
  refValue: string;
  label: CashflowContactLabel | undefined;
  /** For a transfer with no name of its own: the name it gets from its address. */
  inherited?: string | null;
  compact?: boolean;
}) {
  const { run, busy } = useCashflowActions();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label?.label ?? '');
  const what = kind === 'address' ? 'this address' : 'this transfer';

  if (editing) {
    return (
      <form
        className="inline-flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(`Named ${what} “${name.trim()}”`, (t, view) =>
            addCashflowContactLabel(t, { kind, chain, ref: refValue, label: name }, view),
          ).then((ok) => ok && setEditing(false));
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          list={CONTACT_NAMES_LIST}
          maxLength={100}
          autoFocus
          placeholder="Who is this? e.g. Bob"
          aria-label={`Name for ${what}`}
          className="w-36 rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 text-xs text-gray-200"
        />
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md bg-purple-600 px-2 py-0.5 text-xs text-white hover:bg-purple-500 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="text-xs text-gray-400 hover:text-white"
        >
          Cancel
        </button>
      </form>
    );
  }

  if (label) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => {
            setName(label.label);
            setEditing(true);
          }}
          title={`Rename — ${kind === 'address' ? 'applies to every transfer with this address' : 'just this transfer'}`}
          className="rounded bg-sky-500/15 px-1.5 py-0.5 text-xs text-sky-200 hover:bg-sky-500/25"
        >
          👤 {label.label}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run('Name removed', (t, view) => removeCashflowContactLabel(t, label.id, view))
          }
          title="Remove this name"
          aria-label="Remove this name"
          className="text-xs text-gray-500 hover:text-white disabled:opacity-50"
        >
          ×
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {inherited && (
        <span
          className="rounded bg-sky-500/10 px-1.5 py-0.5 text-xs text-sky-300/80"
          title="Named on the address"
        >
          👤 {inherited}
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          setName(inherited ?? '');
          setEditing(true);
        }}
        title={
          kind === 'address'
            ? 'Name the person behind this address — all their transfers add up under that name'
            : 'Name who this one transfer was with (e.g. a friend paying from their exchange account). Naming a transfer from an exchange counts it as their money, not yours.'
        }
        className={cn(
          'text-xs underline-offset-2 hover:underline',
          compact ? 'text-gray-500 hover:text-sky-300' : 'text-sky-300 hover:text-sky-200',
        )}
      >
        {inherited ? 'Different person?' : kind === 'address' ? 'Name who this is…' : 'Name…'}
      </button>
    </span>
  );
}

/** Your note on a transaction: shown inline, edited in place. */
export function TxNoteControl({
  chain,
  txHash,
  note,
  compact,
}: {
  chain: string;
  txHash: string;
  note: CashflowTxNote | undefined;
  compact?: boolean;
}) {
  const { run, busy } = useCashflowActions();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note?.note ?? '');

  if (editing) {
    return (
      <form
        className="mt-1 flex w-full flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(text.trim() ? 'Note saved' : 'Note removed', (t, view) =>
            setCashflowTxNote(t, { chain, txHash, note: text }, view),
          ).then((ok) => ok && setEditing(false));
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          rows={2}
          autoFocus
          placeholder="Your note on this transaction"
          aria-label="Note"
          className="min-w-64 flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs text-gray-200"
        />
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-purple-600 px-2 py-1 text-xs text-white hover:bg-purple-500 disabled:opacity-50"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs text-gray-400 hover:text-white"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }
  if (note) {
    return (
      <button
        type="button"
        onClick={() => {
          setText(note.note);
          setEditing(true);
        }}
        title="Edit note"
        className="whitespace-pre-wrap text-left text-xs italic text-amber-200/90 hover:text-amber-100"
      >
        📝 {note.note}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        setText('');
        setEditing(true);
      }}
      className={cn(
        'text-xs underline-offset-2 hover:underline',
        compact ? 'text-gray-500 hover:text-amber-200' : 'text-gray-400 hover:text-amber-200',
      )}
    >
      📝 Add note
    </button>
  );
}

export type TransferRow = CashflowCounterpartyTransfer & { address: string };

/**
 * Transfers one by one (for an address, an exchange or a person), each with
 * its person name and your note.
 */
export function TransfersTable({
  rows,
  report,
  showAddress,
}: {
  rows: TransferRow[];
  report: CashflowReport;
  showAddress?: boolean;
}) {
  const notes = notesByTx(report);
  const [limit, setLimit] = useState(50);
  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-gray-500">
            <tr>
              <th className="py-1.5 pr-3 font-medium">Date</th>
              {showAddress && <th className="py-1.5 pr-3 font-medium">Address</th>}
              <th className="py-1.5 pr-3 font-medium">Direction</th>
              <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
              <th className="py-1.5 pr-3 text-right font-medium">USD</th>
              <th className="py-1.5 pr-3 font-medium">Who</th>
              <th className="py-1.5 font-medium">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {sorted.slice(0, limit).map((t, i) => {
              const url = txExplorerUrl(t.chain, t.txHash);
              const own = findContactLabel(report, 'tx', t.chain, t.txHash);
              const inherited = findContactLabel(report, 'address', t.chain, t.address)?.label;
              return (
                <tr key={`${t.chain}:${t.txHash}:${t.address}:${i}`} className="align-top">
                  <td className="whitespace-nowrap py-1.5 pr-3 text-gray-400">
                    {new Date(t.at).toLocaleDateString()}
                    <div className="text-gray-600">{CHAIN_LABELS[t.chain] ?? t.chain}</div>
                  </td>
                  {showAddress && (
                    <td className="py-1.5 pr-3 font-mono text-gray-300">
                      {t.address.length > 16 ? truncateAddress(t.address) : t.address}
                    </td>
                  )}
                  <td
                    className={cn(
                      'whitespace-nowrap py-1.5 pr-3',
                      t.direction === 'in' ? 'text-sky-300' : 'text-orange-300',
                    )}
                  >
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open this transaction on ${explorerName(t.chain)}`}
                        className="underline decoration-gray-600 underline-offset-2 hover:text-purple-300"
                      >
                        {t.direction === 'in' ? '← Received' : '→ Sent'}{' '}
                        <span aria-hidden="true">↗</span>
                      </a>
                    ) : t.direction === 'in' ? (
                      '← Received'
                    ) : (
                      '→ Sent'
                    )}
                    {t.exchange && <div className="text-gray-500">{t.exchange} account</div>}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-gray-200">
                    {qty(t.amount)} {t.symbol ?? ''}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-gray-300">
                    {usd(t.usd)}
                  </td>
                  <td className="py-1.5 pr-3">
                    <ContactLabelControl
                      key={own?.id ?? 'none'}
                      kind="tx"
                      chain={t.chain}
                      refValue={t.txHash}
                      label={own}
                      inherited={inherited}
                      compact
                    />
                  </td>
                  <td className="py-1.5">
                    <TxNoteControl
                      key={notes.get(flagKey(t.chain, t.txHash))?.updatedAt ?? 'none'}
                      chain={t.chain}
                      txHash={t.txHash}
                      note={notes.get(flagKey(t.chain, t.txHash))}
                      compact
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > limit && (
        <button
          type="button"
          onClick={() => setLimit(limit + 50)}
          className="mt-2 text-xs text-gray-400 hover:text-white"
        >
          Show more ({sorted.length - limit} remaining)
        </button>
      )}
      {sorted.length === 0 && <p className="py-3 text-center text-gray-500">Nothing here.</p>}
    </div>
  );
}
