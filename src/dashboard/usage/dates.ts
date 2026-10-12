function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

export function dayKeyDaysAgo(now: number, daysAgo: number): string {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return dayKey(d.getTime());
}
