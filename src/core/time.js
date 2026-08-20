export function calendarActivityWindow(lookbackDays, now = new Date()) {
  const days = Math.max(1, Math.floor(Number(lookbackDays) || 1));
  const untilDate = new Date(now);
  const sinceDate = new Date(untilDate);
  sinceDate.setDate(sinceDate.getDate() - (days - 1));
  sinceDate.setHours(0, 0, 0, 0);
  return { sinceDate, untilDate };
}
