const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
const labels = { live: '直播中', upcoming: '未开始', finished: '已结束', postponed: '已推迟', cancelled: '已取消', unknown: '状态待确认' };
function schedule({ date, time, startAt, status, league } = {}, now = Date.now()) {
  let stamp = 0;
  if (Number(startAt) > 0) stamp = Number(startAt) * (Number(startAt) < 1e12 ? 1000 : 1);
  else {
    const value = String(startAt || [date, time].filter(Boolean).join(' ')).trim();
    const full = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
    if (full) stamp = Date.parse(`${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}T${(full[4] || '00').padStart(2, '0')}:${full[5] || '00'}:${full[6] || '00'}+08:00`);
    else if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) stamp = Date.parse(value);
  }
  if (!Number.isFinite(stamp) || stamp <= 0 || stamp > 1e14) stamp = 0;
  const raw = String(status || ''), normalized = labels[raw] ? raw : /直播中|进行中|live|in.progress/i.test(raw) ? 'live' : /已结束|完场|完赛|finished|ended|complete/i.test(raw) ? 'finished' : /未开始|即将|upcoming|scheduled/i.test(raw) ? 'upcoming' : /推迟|延期|postponed/i.test(raw) ? 'postponed' : /取消|cancelled/i.test(raw) ? 'cancelled' : stamp > now ? 'upcoming' : 'unknown';
  return { startAt: stamp, day: stamp ? dayFormat.format(stamp) : '', time: stamp ? clockFormat.format(stamp) : '', status: normalized, statusLabel: labels[normalized], league: String(league || '').slice(0, 160) };
}
function sortEvents(items, now = Date.now()) {
  const today = dayFormat.format(now), rank = { live: 0, upcoming: 1, finished: 2, postponed: 3, cancelled: 4, unknown: 5 };
  const bucket = day => !day ? 3 : day === today ? 0 : day > today ? 1 : 2;
  return [...items].sort((a, b) => {
    const x = a.schedule, y = b.schedule;
    if (!x || !y) return x ? -1 : y ? 1 : 0;
    return bucket(x.day) - bucket(y.day) || (x.day === y.day ? (rank[x.status] ?? 5) - (rank[y.status] ?? 5) || x.startAt - y.startAt : (x.day < today && y.day < today ? y.day.localeCompare(x.day) : x.day.localeCompare(y.day)));
  });
}
module.exports = { schedule, sortEvents };
