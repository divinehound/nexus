'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import type {
  CashflowContactLabel,
  CashflowCounterpartyTransfer,
  CashflowReport,
  CashflowTxNote,
} from '@nexus/types';
import {
  addCashflowContactLabel,
  addCashflowContactLabels,
  removeCashflowContactLabel,
  removeCashflowContactLabels,
  setCashflowAssetPref,
  setCashflowLost,
  setCashflowTxNote,
} from '@/lib/api';
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

export interface MenuItem {
  label: string;
  onSelect: () => void;
  title?: string;
  danger?: boolean;
}

/**
 * A "⋯" button opening a short list of actions, so rows show their data and
 * keep the actions out of the way. Positioned fixed so scrolling tables don't
 * clip it; closes on outside click, Escape, scroll or resize.
 */
export function RowMenu({ items, label = 'Actions' }: { items: MenuItem[]; label?: string }) {
  // Opens toward the side with room: from the button's left edge on the left half of the screen, else its right edge.
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node))
        close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close();
        button.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    menu.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  if (items.length === 0) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title={label}
        onClick={() => {
          if (pos) return setPos(null);
          const r = button.current!.getBoundingClientRect();
          setPos(
            r.left < window.innerWidth / 2
              ? { top: r.bottom + 4, left: Math.max(8, r.left) }
              : { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) },
          );
        }}
        className="rounded px-1.5 leading-5 text-gray-500 hover:bg-gray-800 hover:text-white"
      >
        ⋯
      </button>
      {pos && (
        <div
          ref={menu}
          role="menu"
          style={pos}
          className="fixed z-50 min-w-48 rounded-lg border border-gray-700 bg-gray-900 py-1 text-left text-xs shadow-xl"
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              title={it.title}
              onClick={() => {
                setPos(null);
                it.onSelect();
              }}
              className={cn(
                'block w-full whitespace-nowrap px-3 py-1.5 text-left hover:bg-gray-800 focus:bg-gray-800 focus:outline-none',
                it.danger ? 'text-red-300' : 'text-gray-200',
              )}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Whether you marked what this transaction sent away as lost for good. */
export function isLostTx(report: CashflowReport, chain: string, txHash: string): boolean {
  const key = flagKey(chain, txHash);
  return report.lostTxs.some((l) => flagKey(l.chain, l.txHash) === key);
}

/**
 * The "Mark as lost" / "Not lost" menu item for a transaction that sent
 * assets away — e.g. into an escrow that got locked for good.
 */
export function useLostMenuItem(report: CashflowReport) {
  const { run } = useCashflowActions();
  return (chain: string, txHash: string): MenuItem => {
    const lost = isLostTx(report, chain, txHash);
    return lost
      ? {
          label: 'Not lost (undo)',
          onSelect: () =>
            void run('No longer marked lost', (tk, view) =>
              setCashflowLost(tk, { chain, txHash, lost: false }, view),
            ),
        }
      : {
          label: 'Mark as lost for good…',
          title:
            "What this sent away can't be recovered (e.g. stuck in a locked escrow): its cost is booked as a realized loss.",
          onSelect: () => {
            if (
              window.confirm(
                'Mark what this transaction sent away as lost for good? Its cost will count as a realized loss. You can undo this.',
              )
            )
              void run('Marked lost — its cost now counts as a realized loss', (tk, view) =>
                setCashflowLost(tk, { chain, txHash, lost: true }, view),
              );
          },
        };
  };
}

/** A ⋯ menu with just "Mark as lost" / "Not lost" for one transaction. */
export function LostMenu({
  report,
  chain,
  txHash,
}: {
  report: CashflowReport;
  chain: string;
  txHash: string;
}) {
  const item = useLostMenuItem(report);
  return <RowMenu items={[item(chain, txHash)]} label="Transfer actions" />;
}

/** A person's name as shown on a row: solid when set here, faded when it comes from the address. */
export function ContactChip({ name, inherited }: { name: string; inherited?: boolean }) {
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-xs',
        inherited ? 'bg-sky-500/10 text-sky-300/80' : 'bg-sky-500/15 text-sky-200',
      )}
      title={inherited ? 'Named on the address' : undefined}
    >
      👤 {name}
    </span>
  );
}

/** Form naming the person behind an address (every transfer with it) or one transfer. */
export function ContactNameEditor({
  kind,
  chain,
  refValue,
  initial,
  onDone,
}: {
  kind: 'address' | 'tx';
  chain: string;
  /** The address, or the tx hash. */
  refValue: string;
  initial: string;
  onDone: () => void;
}) {
  const { run, busy } = useCashflowActions();
  const [name, setName] = useState(initial);
  const what = kind === 'address' ? 'this address' : 'this transfer';
  return (
    <form
      className="mt-1.5 flex flex-wrap items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void run(`Named ${what} “${name.trim()}”`, (t, view) =>
          addCashflowContactLabel(t, { kind, chain, ref: refValue, label: name }, view),
        ).then((ok) => ok && onDone());
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
        className="w-40 rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 text-xs text-gray-200"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="rounded-md bg-purple-600 px-2 py-0.5 text-xs text-white hover:bg-purple-500 disabled:opacity-50"
      >
        Save
      </button>
      <button type="button" onClick={onDone} className="text-xs text-gray-400 hover:text-white">
        Cancel
      </button>
      <span className="text-[11px] text-gray-500">
        {kind === 'address'
          ? 'Applies to every transfer with this address.'
          : 'Just this transfer. Naming a transfer from an exchange counts it as their money, not yours.'}
      </span>
    </form>
  );
}

/** Form for your note on a transaction; saving it empty removes it. */
export function NoteEditor({
  chain,
  txHash,
  initial,
  onDone,
}: {
  chain: string;
  txHash: string;
  initial: string;
  onDone: () => void;
}) {
  const { run, busy } = useCashflowActions();
  const [text, setText] = useState(initial);
  return (
    <form
      className="mt-1.5 flex w-full flex-wrap items-start gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(text.trim() ? 'Note saved' : 'Note removed', (t, view) =>
          setCashflowTxNote(t, { chain, txHash, note: text }, view),
        ).then((ok) => ok && onDone());
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
        <button type="button" onClick={onDone} className="text-xs text-gray-400 hover:text-white">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Menu items to name/rename/unname an address or transfer. */
export function contactMenuItems(
  label: CashflowContactLabel | undefined,
  kind: 'address' | 'tx',
  onEdit: () => void,
  remove: (id: string) => void,
  inherited?: string | null,
): MenuItem[] {
  if (label)
    return [
      { label: `Rename “${label.label}”…`, onSelect: onEdit },
      { label: 'Remove name', onSelect: () => remove(label.id), danger: true },
    ];
  if (kind === 'tx')
    return [
      {
        label: inherited ? 'A different person…' : 'Name who this was with…',
        onSelect: onEdit,
        title: 'e.g. a friend paying from their exchange account',
      },
    ];
  return [{ label: 'Name who this is…', onSelect: onEdit }];
}

/** Your note in a details panel: shown, with an edit/add link. */
export function TxNoteControl({
  chain,
  txHash,
  note,
}: {
  chain: string;
  txHash: string;
  note: CashflowTxNote | undefined;
}) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <NoteEditor
        chain={chain}
        txHash={txHash}
        initial={note?.note ?? ''}
        onDone={() => setEditing(false)}
      />
    );
  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={note ? 'Edit note' : undefined}
      className={cn(
        'whitespace-pre-wrap text-left text-xs',
        note
          ? 'italic text-amber-200/90 hover:text-amber-100'
          : 'text-gray-400 underline-offset-2 hover:text-amber-200 hover:underline',
      )}
    >
      📝 {note ? note.note : 'Add note'}
    </button>
  );
}

export type TransferRow = CashflowCounterpartyTransfer & { address: string };

/**
 * Transfers one by one (for an address, an exchange or a person), each with
 * its person name and your note; actions sit in a ⋯ menu per row.
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
  const [limit, setLimit] = useState(50);
  // Selected transfers (by tx — a name is per transaction), for naming several at once.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  const notes = notesByTx(report);
  const shown = sorted.slice(0, limit);
  const shownKeys = [...new Set(shown.map((t) => flagKey(t.chain, t.txHash)))];
  const allShown = shownKeys.length > 0 && shownKeys.every((k) => selected.has(k));
  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const picked = sorted.filter((t) => selected.has(flagKey(t.chain, t.txHash)));
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/40 p-3">
      {selected.size > 0 && (
        <BulkNameBar
          targets={[...new Map(picked.map((t) => [flagKey(t.chain, t.txHash), t])).values()].map(
            (t) => ({ kind: 'tx' as const, chain: t.chain, ref: t.txHash }),
          )}
          report={report}
          onDone={() => setSelected(new Set())}
        />
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-gray-500">
            <tr>
              <th className="w-6 py-1.5 pr-2">
                <input
                  type="checkbox"
                  checked={allShown}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const k of shownKeys) {
                        if (allShown) next.delete(k);
                        else next.add(k);
                      }
                      return next;
                    })
                  }
                  aria-label={allShown ? 'Unselect all' : 'Select all to name them together'}
                  title={allShown ? 'Unselect all' : 'Select all to name them together'}
                />
              </th>
              <th className="py-1.5 pr-3 font-medium">Date</th>
              {showAddress && <th className="py-1.5 pr-3 font-medium">Address</th>}
              <th className="py-1.5 pr-3 font-medium">Direction</th>
              <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
              <th className="py-1.5 pr-3 text-right font-medium">USD</th>
              <th className="py-1.5 pr-3 font-medium">Who · note</th>
              <th className="w-6 py-1.5">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800/60">
            {shown.map((t, i) => (
              <TransferLine
                key={`${t.chain}:${t.txHash}:${t.address}:${i}`}
                selected={selected.has(flagKey(t.chain, t.txHash))}
                onToggle={() => toggle(flagKey(t.chain, t.txHash))}
                t={t}
                report={report}
                note={notes.get(flagKey(t.chain, t.txHash))}
                showAddress={showAddress}
              />
            ))}
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

export interface ContactTarget {
  kind: 'address' | 'tx';
  chain: string;
  ref: string;
}

/** Name every selected address or transfer at once, or clear the names they have. */
export function BulkNameBar({
  targets,
  report,
  onDone,
}: {
  targets: ContactTarget[];
  report: CashflowReport;
  onDone: () => void;
}) {
  const { run, busy } = useCashflowActions();
  const [name, setName] = useState('');
  const named = targets
    .map((t) => findContactLabel(report, t.kind, t.chain, t.ref))
    .filter((l): l is CashflowContactLabel => !!l);
  const n = targets.length;
  const noun = (count: number) =>
    targets[0]?.kind === 'address'
      ? `address${count === 1 ? '' : 'es'}`
      : `transfer${count === 1 ? '' : 's'}`;
  return (
    <form
      className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-purple-500/10 px-2 py-1.5 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void run(`Named ${n} ${noun(n)} “${name.trim()}”`, (tk, view) =>
          addCashflowContactLabels(tk, { targets, label: name }, view),
        ).then((ok) => ok && onDone());
      }}
    >
      <span className="text-purple-200">
        {n} {noun(n)} selected
      </span>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        list={CONTACT_NAMES_LIST}
        maxLength={100}
        placeholder="Who is this? e.g. Bob"
        aria-label={`Name for the selected ${noun(2)}`}
        className="w-48 rounded-md border border-gray-700 bg-gray-900 px-2 py-0.5 text-gray-200"
      />
      <button
        type="submit"
        disabled={busy || !name.trim()}
        className="rounded-md bg-purple-600 px-2 py-0.5 text-white hover:bg-purple-500 disabled:opacity-50"
      >
        Name them
      </button>
      {named.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(`Cleared ${named.length} name${named.length === 1 ? '' : 's'}`, (tk, view) =>
              removeCashflowContactLabels(
                tk,
                named.map((l) => l.id),
                view,
              ),
            ).then((ok) => ok && onDone())
          }
          title={
            targets[0]?.kind === 'tx'
              ? 'Remove the names given to these transfers (names on their addresses stay)'
              : 'Remove the names on these addresses'
          }
          className="text-red-300 hover:text-red-200 disabled:opacity-50"
        >
          Clear their names
        </button>
      )}
      <button type="button" onClick={onDone} className="ml-auto text-gray-400 hover:text-white">
        Unselect
      </button>
    </form>
  );
}

function TransferLine({
  t,
  report,
  note,
  showAddress,
  selected,
  onToggle,
}: {
  selected: boolean;
  onToggle: () => void;
  t: TransferRow;
  report: CashflowReport;
  note: CashflowTxNote | undefined;
  showAddress?: boolean;
}) {
  const { run } = useCashflowActions();
  const [editing, setEditing] = useState<'name' | 'note' | null>(null);
  const url = txExplorerUrl(t.chain, t.txHash);
  const own = findContactLabel(report, 'tx', t.chain, t.txHash);
  const inherited = findContactLabel(report, 'address', t.chain, t.address)?.label ?? null;
  const items: MenuItem[] = [
    ...contactMenuItems(
      own,
      'tx',
      () => setEditing('name'),
      (id) => void run('Name removed', (tk, view) => removeCashflowContactLabel(tk, id, view)),
      inherited,
    ),
    { label: note ? 'Edit note…' : 'Add note…', onSelect: () => setEditing('note') },
    ...(note
      ? [
          {
            label: 'Remove note',
            danger: true,
            onSelect: () =>
              void run('Note removed', (tk, view) =>
                setCashflowTxNote(tk, { chain: t.chain, txHash: t.txHash, note: '' }, view),
              ),
          },
        ]
      : []),
  ];
  const cols = showAddress ? 8 : 7;
  return (
    <Fragment>
      <tr className={cn('align-top', selected && 'bg-purple-500/5')}>
        <td className="py-1.5 pr-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            aria-label="Select this transfer"
          />
        </td>
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
              {t.direction === 'in' ? '← Received' : '→ Sent'} <span aria-hidden="true">↗</span>
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
        <td className="py-1.5 pr-3 text-right tabular-nums text-gray-300">{usd(t.usd)}</td>
        <td className="py-1.5 pr-3">
          <div className="flex flex-wrap items-center gap-2">
            {own ? (
              <ContactChip name={own.label} />
            ) : inherited ? (
              <ContactChip name={inherited} inherited />
            ) : null}
            {note && (
              <span className="whitespace-pre-wrap italic text-amber-200/90">📝 {note.note}</span>
            )}
            {!own && !inherited && !note && <span className="text-gray-600">—</span>}
          </div>
        </td>
        <td className="py-1.5 text-right">
          <RowMenu items={items} label="Transfer actions" />
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={cols} className="pb-2">
            {editing === 'name' ? (
              <ContactNameEditor
                kind="tx"
                chain={t.chain}
                refValue={t.txHash}
                initial={own?.label ?? inherited ?? ''}
                onDone={() => setEditing(null)}
              />
            ) : (
              <NoteEditor
                chain={t.chain}
                txHash={t.txHash}
                initial={note?.note ?? ''}
                onDone={() => setEditing(null)}
              />
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** ⋯ on a token/collection row: hide it (spam, dust, not yours), or undo "not spam". */
export function AssetMenu({ report, assetKey }: { report: CashflowReport; assetKey: string }) {
  const { run } = useCashflowActions();
  const keptAsNotSpam = report.shownAssets.includes(assetKey);
  const items: MenuItem[] = [
    {
      label: 'Hide — spam or not mine',
      title:
        'Leave it out of P/L, spending and holdings (for a collection NEXUS tracks, this also reports it as spam for review). You can bring it back from the hidden list.',
      onSelect: () =>
        void run('Hidden — left out of the report', (tk, view) =>
          setCashflowAssetPref(tk, { assetKey, pref: 'hidden' }, view),
        ),
    },
    ...(keptAsNotSpam
      ? [
          {
            label: 'Let the spam check decide again',
            onSelect: () =>
              void run('Back to the automatic spam check', (tk, view) =>
                setCashflowAssetPref(tk, { assetKey, pref: null }, view),
              ),
          },
        ]
      : []),
  ];
  return <RowMenu items={items} label="Token actions" />;
}

const HIDDEN_REASONS = {
  flagged: 'flagged as spam by NEXUS',
  spam: 'looks like spam (link in its name)',
  hidden: 'hidden by you',
} as const;

/** Tokens/collections left out of the report, with a way to bring each back. */
export function HiddenAssets({
  report,
  kind,
}: {
  report: CashflowReport;
  kind: 'nft' | 'fungible';
}) {
  const { run, busy } = useCashflowActions();
  const [open, setOpen] = useState(false);
  const hidden = report.hiddenAssets.filter((h) => h.kind === kind);
  if (hidden.length === 0) return null;
  const spam = hidden.filter((h) => h.reason !== 'hidden').length;
  return (
    <div className="mt-3 text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="text-gray-400 hover:text-white"
      >
        {open ? '▾' : '▸'} {hidden.length} hidden
        {spam > 0 ? ` (${spam} look${spam === 1 ? 's' : ''} like spam)` : ''}
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-gray-800/60 rounded-lg border border-gray-800 bg-gray-900/40 px-3">
          {hidden.map((h) => (
            <li key={h.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 truncate text-gray-300" title={h.name}>
                {h.name}
              </span>
              <span className="text-gray-500">{CHAIN_LABELS[h.chain] ?? h.chain}</span>
              <span className={h.reason === 'hidden' ? 'text-gray-500' : 'text-amber-300/90'}>
                {HIDDEN_REASONS[h.reason]}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(h.reason === 'hidden' ? 'Unhidden' : 'Kept — not spam', (tk, view) =>
                    setCashflowAssetPref(
                      tk,
                      { assetKey: h.key, pref: h.reason === 'hidden' ? null : 'shown' },
                      view,
                    ),
                  )
                }
                className="text-purple-300 hover:text-purple-200 disabled:opacity-50"
              >
                {h.reason === 'hidden' ? 'Unhide' : 'Not spam'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
