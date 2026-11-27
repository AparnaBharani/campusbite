const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function campusTime(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return {
    weekday: WEEKDAYS[parts.find((part) => part.type === "weekday").value],
    hour: Number(parts.find((part) => part.type === "hour").value),
  };
}

export function predictDemand(history, target = new Date()) {
  const rows = history.filter((row) => {
    const time = new Date(row.occurred_at);
    return Number.isFinite(time.getTime()) &&
      time <= target &&
      time >= new Date(target.getTime() - 28 * DAY_MS);
  });

  const { weekday, hour } = campusTime(target);
  const byItem = new Map();

  for (const row of rows) {
    const time = new Date(row.occurred_at);
    const observed = campusTime(time);
    const ageDays = (target.getTime() - time.getTime()) / DAY_MS;
    const weight = ageDays <= 7 ? 1.5 : 1;
    const item = byItem.get(row.menu_item_id) || { score: 0, samples: 0, matchingSlots: 0 };
    item.score += Number(row.quantity) * weight *
      (observed.weekday === weekday && observed.hour === hour ? 2.5 :
        observed.weekday === weekday ? 1.4 :
          observed.hour === hour ? 1.2 : 1);
    item.samples += 1;
    if (observed.weekday === weekday && observed.hour === hour) item.matchingSlots += 1;
    byItem.set(row.menu_item_id, item);
  }

  return [...byItem.entries()]
    .map(([id, value]) => ({
      menu_item_id: Number(id),
      predicted_demand: Math.round(value.score / 28 * 10) / 10,
      confidence: value.matchingSlots >= 3 && value.samples >= 8 ? 'high' :
        value.samples >= 4 ? 'medium' : 'early',
    }))
    .sort((a, b) => b.predicted_demand - a.predicted_demand);
}
