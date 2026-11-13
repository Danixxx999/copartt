'use strict';
// Construye la rejilla semanal (lunes→domingo) del calendario de subastas en hora de Madrid.
const TZ = 'Europe/Madrid';
const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
function mondayOf(d) {
  const local = new Date(`${ymd(d)}T12:00:00Z`);
  const dow = (local.getUTCDay() + 6) % 7; // 0 = lunes
  local.setUTCDate(local.getUTCDate() - dow);
  return local;
}
function buildCalendar(events, weeksCount = 6) {
  const start = mondayOf(new Date());
  const byDay = new Map();
  for (const e of events) { const k = ymd(new Date(e.starts_at)); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); }
  const weeks = [];
  for (let w = 0; w < weeksCount; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setUTCDate(start.getUTCDate() + w * 7 + i);
      const key = d.toISOString().slice(0, 10);
      days.push({ key, label: d.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' }), date: d.toLocaleDateString('en-GB', { timeZone: 'UTC' }), events: byDay.get(key) || [], today: key === ymd(new Date()) });
    }
    const times = [...new Set(days.flatMap(d => d.events.map(e => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(e.starts_at)))))].sort();
    weeks.push({ days, times });
  }
  return weeks;
}
module.exports = { buildCalendar };
