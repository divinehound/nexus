'use client';

import { cn } from '@/lib/utils';
import { pnlClass, usdSigned } from './format';

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
        {swatch && <span className="inline-block h-2 w-2 rounded-sm" style={{ background: swatch }} aria-hidden="true" />}
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
