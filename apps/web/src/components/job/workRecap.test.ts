import { expect, it } from "vite-plus/test";

import { localWorkDate, workRecapWindows } from "./workRecap";

it("reports from the last workday and the start of the week in local time", () => {
  // Sunday 1 March: the standup covers Friday, the demo covers the week since Monday.
  const sunday = workRecapWindows(new Date(2026, 2, 1, 12));
  expect(localWorkDate(new Date(sunday.lastWorkday))).toBe("2026-02-27");
  expect(new Date(sunday.today).getHours()).toBe(0);
  expect(localWorkDate(new Date(sunday.week))).toBe("2026-02-23");
  const monday = workRecapWindows(new Date(2026, 2, 2, 9));
  expect(localWorkDate(new Date(monday.lastWorkday))).toBe("2026-02-27");
  expect(localWorkDate(new Date(monday.week))).toBe("2026-02-23");
  const wednesday = workRecapWindows(new Date(2026, 2, 4, 9));
  expect(localWorkDate(new Date(wednesday.lastWorkday))).toBe("2026-03-03");
  expect(localWorkDate(new Date(wednesday.week))).toBe("2026-03-02");
});
