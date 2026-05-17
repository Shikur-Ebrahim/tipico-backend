/** Day filter ids aligned with frontend home page (`all`, `today`, `tomorrow`, `date:YYYY-MM-DD`). */
export function getDayRangeFromId(dayId: string): { start: Date; endExclusive: Date } | null {
  if (!dayId || dayId === 'all') return null;

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  if (dayId === 'today') {
    const end = new Date(todayStart);
    end.setDate(end.getDate() + 1);
    return { start: todayStart, endExclusive: end };
  }

  if (dayId === 'tomorrow') {
    const start = new Date(todayStart);
    start.setDate(start.getDate() + 1);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, endExclusive: end };
  }

  if (dayId.startsWith('date:')) {
    const ymd = dayId.slice(5);
    const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));
    if (!y || !m || !d) return null;
    const start = new Date(y, m - 1, d, 0, 0, 0, 0);
    const endExclusive = new Date(start);
    endExclusive.setDate(endExclusive.getDate() + 1);
    return { start, endExclusive };
  }

  return null;
}

/** Build 7-day day option ids (today, tomorrow, date:…). */
export function buildRollingDayIds(): string[] {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const ids = ['all', 'today', 'tomorrow'];
  for (let i = 2; i < 7; i++) {
    const date = new Date(todayStart);
    date.setDate(todayStart.getDate() + i);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    ids.push(`date:${y}-${m}-${day}`);
  }
  return ids;
}
