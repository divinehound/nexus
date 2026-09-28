'use client';

import { cn } from '@/lib/utils';
import { nativeAmount, pnlClass, usd, usdSigned } from './format';

export function Stat({
  label,
  value,
  valueClass,
  swatch,
  sub,
}: {
  label: string;
  value: string;
  valueClass?: string;
  swatch?: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-gray-800 p-3">
      <div className="flex items-center gap-1.5 text-xs text-gray-500">
        {swatch && (
          <span
            className="inline-block h-2 w-2 rounded-sm"
            style={{ background: swatch }}
            aria-hidden="true"
          />
        )}
        {label}
      </div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', valueClass)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  );
}

export function AfterGas({ value }: { value: number }) {
  return (
    <>
      after gas <span className={cn('tabular-nums', pnlClass(value))}>{usdSigned(value)}</span>
    </>
  );
}

/**
 * A money value in USD with the same amount in the chain's own coin underneath.
 * For P/L (`signed`), each line is coloured by its own sign — they can
 * disagree when the coin's price moved while you held.
 */
export function Dual({
  usd: usdValue,
  native,
  symbol,
  signed = false,
}: {
  usd: number | null;
  native: number | null;
  symbol: string;
  signed?: boolean;
}) {
  if (usdValue === null && native === null) return <>—</>;
  return (
    <>
      <div className={cn(signed && usdValue !== null && pnlClass(usdValue))}>
        {usdValue === null ? '—' : signed ? usdSigned(usdValue) : usd(usdValue)}
      </div>
      {native !== null && (
        <div
          className={cn(
            'text-xs',
            signed ? pnlClass(native) : 'text-gray-500',
            signed && 'opacity-80',
          )}
        >
          {nativeAmount(native, symbol, signed)}
        </div>
      )}
    </>
  );
}

/** A small "open in explorer" icon link, placed after a name or address. */
export function ExplorerIcon({ url, label }: { url: string; label: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className="inline-flex shrink-0 text-gray-500 hover:text-purple-300"
    >
      <svg
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden="true"
      >
        <path
          d="M6.5 3.5H3.75a.75.75 0 0 0-.75.75v8c0 .41.34.75.75.75h8c.41 0 .75-.34.75-.75V9.5"
          strokeLinecap="round"
        />
        <path d="M9.5 2.75h3.75v3.75M13 3 7.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}
