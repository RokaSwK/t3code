/** The client's local date; the recap and today's plan follow the user's timezone. */
export function localWorkDate(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * The standup covers everything since the start of the last workday, so Monday reports Friday
 * and the weekend. The demo covers this week since Monday, or all of last week on a Monday.
 */
export function workRecapWindows(now: Date) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = today.getDay();
  const lastWorkday = new Date(today);
  lastWorkday.setDate(today.getDate() - (day === 1 ? 3 : day === 0 ? 2 : 1));
  const week = new Date(today);
  week.setDate(today.getDate() - ((day + 6) % 7 || 7));
  return { today: today.getTime(), lastWorkday: lastWorkday.getTime(), week: week.getTime() };
}
