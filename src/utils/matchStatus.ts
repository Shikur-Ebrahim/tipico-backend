function regulationMinute(raw: unknown): number {
  if (raw == null || raw === '') return 0;
  const s = String(raw).trim();
  const plus = s.indexOf('+');
  const head = (plus >= 0 ? s.slice(0, plus) : s).trim();
  const lead = head.match(/^(\d+)/);
  if (lead) return Number(lead[1]);
  const n = Number(head);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Same rules as frontend `isMatchClosedForBetting`: settle 1X2 at FT/AET/PEN
 * or at 90'+ in 2H/LIVE (regulation clock).
 */
export function isFixtureFinishedForSettlement(
  status: string | null | undefined,
  minute: number | string | null | undefined
): boolean {
  const s = String(status || '').toUpperCase();
  if (['FT', 'AET', 'PEN'].includes(s)) return true;
  const m = regulationMinute(minute);
  if (m >= 90 && (s === '2H' || s === 'LIVE')) return true;
  return false;
}

/** Only not-yet-kicked fixtures: open for copying a ticket and placing the same picks. */
export function isFixturePreMatchOnly(status: string | null | undefined): boolean {
  const s = String(status || '').trim().toUpperCase();
  return s === '' || s === 'NS' || s === 'TBD';
}
