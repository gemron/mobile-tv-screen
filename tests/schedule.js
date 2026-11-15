const assert = require('assert/strict');
const http = require('http');
const { schedule, sortEvents } = require('../src/content/schedule');
const catalog = require('../src/content/catalog');
const now = Date.parse('2026-11-16T12:00:00+08:00');
const item = (id, date, time, status) => ({ id, schedule: schedule({ date, time, status }, now) });
const rows = [item('past', '2026-11-15', '21:00', '已结束'), item('later', '2026-11-17', '10:00', '未开始'), item('ended', '2026-11-16', '9:00', '已结束'), item('soon', '2026-11-16', '13:00', '未开始'), item('live', '2026-11-16', '11:00', '直播中')];
assert.deepEqual(sortEvents(rows, now).map(item => item.id), ['live', 'soon', 'ended', 'later', 'past']);
assert.equal(rows[2].schedule.time, '09:00');
assert.equal(schedule({ startAt: now / 1000, status: 'live' }).day, '2026-11-16');
assert.equal(schedule({ startAt: 'invalid' }).status, 'unknown');
assert.equal(schedule({ date: '2026-11-16', time: '11:00' }, now).status, 'unknown', 'Past time alone does not prove that a match has finished');
assert.equal(schedule({ startAt: '2026-11-16T04:00:00Z' }).time, '12:00');

(async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<div class="list-group-item live-list-group-time">2026-11-16</div>' + ['已结束', '直播中', '未开始'].map((status, index) => `<div class="list-group-item group-game-item"><div class="row d-none"><span class="category-game-time">${['09:00','11:00','18:00'][index]}</span><span class="game-type">League</span><span class="team-name">Home ${index}</span><span class="team-name">Away ${index}</span><div class="pay-btn"><a class="btn" href="/play/${index}">${status}</a></div></div></div>`).join(''));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const site = catalog.describeSite({ api: 'csp_KanqiuGuard', type: 3, ext: { siteUrl: base } }, base, 0), result = await catalog.home(site);
    assert.deepEqual(result.list.map(item => item.schedule.status), ['live', 'upcoming', 'finished']);
    assert.equal(result.list[0].title, 'Home 1 VS Away 1'); assert.equal(result.list[0].schedule.day, '2026-11-16');
    assert.ok(!result.list[0].title.includes('直播中'), 'Status and time stay structured instead of becoming part of the title');
    console.log('PASS: Shanghai match dates, live/upcoming/finished order, unknown-state handling and real Kanqiu HTML normalization');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
