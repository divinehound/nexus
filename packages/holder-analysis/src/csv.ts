// CSV out: RFC 4180 quoting, header from the first row's keys (or the given list).

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: Record<string, unknown>[] | unknown[][], header?: string[]): string {
  const cols = header ?? (rows.length && !Array.isArray(rows[0]) ? Object.keys(rows[0] as object) : []);
  const lines = [cols.map(cell).join(",")];
  for (const r of rows) lines.push((Array.isArray(r) ? r : cols.map((c) => (r as Record<string, unknown>)[c])).map(cell).join(","));
  return lines.join("\n") + "\n";
}
