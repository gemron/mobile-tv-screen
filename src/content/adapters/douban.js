const { resource } = require('../http');
const { json, webUrl } = require('../format');

const classes = [
  ['hot_movie', '热播电影'], ['hot_tv', '热播剧集'], ['hot_show', '热播综艺'],
  ['movie', '电影筛选'], ['tv', '电视筛选'], ['movie_rank', '电影榜单'], ['tv_rank', '电视剧榜单'],
].map(([type_id, type_name]) => ({ type_id, type_name }));
const choice = values => values.map(value => ({ n: value || '全部', v: value }));
const movieRanks = [['movie_top250', '豆瓣 Top 250'], ['movie_weekly_best', '一周口碑榜'], ['movie_real_time_hotest', '实时热门']];
const tvRanks = [['tv_real_time_hotest', '实时热门'], ['tv_american', '英美剧'], ['tv_japanese', '日剧'], ['tv_korean', '韩剧']];
function definitions() {
  const fields = [
    { key: 'genre', name: '类型', value: choice(['', '剧情', '喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '冒险', '纪录片', '历史', '奇幻', '战争']) },
    { key: 'region', name: '地区', value: choice(['', '华语', '欧美', '中国大陆', '中国香港', '中国台湾', '美国', '英国', '法国', '德国', '日本', '韩国', '印度', '泰国']) },
    { key: 'sort', name: '排序', value: [{ n: '近期热度', v: 'U' }, { n: '首映时间', v: 'R' }, { n: '高分优先', v: 'S' }] },
    { key: 'year', name: '年代', value: choice(['', ...Array.from({ length: 30 }, (_, index) => String(new Date().getFullYear() - index))]) },
  ];
  const ranks = values => [{ key: 'collection', name: '榜单', value: values.map(([v, n]) => ({ n, v })) }];
  return { movie: fields, tv: fields, movie_rank: ranks(movieRanks), tv_rank: ranks(tvRanks) };
}
async function settings(site, signal) {
  if (site.doubanSettings) return site.doubanSettings;
  let template = '', ua = '';
  if (site.material && !site.metadataKey) {
    const facts = await site.material.get('DouDou', signal);
    template = facts.strings.find(value => value.includes('frodo.douban.com/api/v2/subject_collection/subject_real_time_hotest/items')) || '';
    ua = facts.strings.find(value => value.includes('MicroMessenger')) || '';
  }
  const apiKey = site.metadataKey || (template && new URL(template).searchParams.get('apikey'));
  if (!apiKey) throw new Error('订阅未提供豆豆片单参数');
  const base = webUrl(site.endpointOverride ? site.api : site.metadataApi || 'https://frodo.douban.com/api/v2/');
  site.doubanSettings = { base: base.endsWith('/') ? base : base + '/', apiKey, headers: { 'user-agent': ua || 'Mozilla/5.0', referer: 'https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html' } };
  return site.doubanSettings;
}
function remember(site, list) {
  site.discoveryCards ||= new Map();
  for (const item of list) { site.discoveryCards.delete(item.vod_id); site.discoveryCards.set(item.vod_id, item); }
  while (site.discoveryCards.size > 300) site.discoveryCards.delete(site.discoveryCards.keys().next().value);
}
async function list(site, { id = '', page = 1, keyword = '', filters = {} } = {}, signal) {
  if (keyword) return { class: classes, filters: definitions(), list: [], notice: '片单不提供正片，请使用“全部片源”搜索。', page: 1, pagecount: 1 };
  let config;
  try { config = await settings(site, signal); }
  catch (error) {
    signal?.throwIfAborted();
    if (!['', 'hot_movie', 'hot_tv'].includes(id)) throw new Error('该分类需要订阅中的豆豆片单参数，请重新导入完整配置');
    const data = json((await resource(new URL('/j/search_subjects?' + new URLSearchParams({ type: id === 'hot_tv' ? 'tv' : 'movie', tag: '热门', page_limit: '20', page_start: String((Number(page) - 1) * 20) }), site.api).href, { headers: site.headers, signal })).text);
    const rows = (data.subjects || []).map(item => ({ vod_id: item.url, vod_name: item.title, vod_pic: item.cover, vod_remarks: '豆瓣 ' + item.rate, searchTitle: item.title })); remember(site, rows);
    return { class: classes.slice(0, 2), list: rows, page, pagecount: rows.length >= 20 ? Number(page) + 1 : Number(page), notice: '正在使用基础片单。点击影片后搜索可播放片源。' };
  }
  let route = ({ '': 'subject_collection/subject_real_time_hotest/items', hot_movie: 'movie/hot_gaia', hot_tv: 'subject_collection/tv_hot/items', hot_show: 'subject_collection/show_hot/items', movie: 'movie/recommend', tv: 'tv/recommend' })[id];
  if (id === 'movie_rank' || id === 'tv_rank') {
    const allowed = id === 'movie_rank' ? movieRanks : tvRanks;
    const selected = allowed.find(([key]) => key === filters.collection)?.[0] || allowed[0][0];
    route = 'subject_collection/' + selected + '/items';
  }
  if (!route) throw Object.assign(new Error('片单分类不存在'), { status: 400 });
  page = Math.max(1, Math.min(10000, Number(page) || 1));
  const url = new URL(route, config.base);
  url.searchParams.set('apikey', config.apiKey); url.searchParams.set('start', String((page - 1) * 20)); url.searchParams.set('count', '20');
  if (id === 'movie' || id === 'tv') {
    url.searchParams.set('sort', ['U', 'R', 'S'].includes(filters.sort) ? filters.sort : 'U');
    url.searchParams.set('tags', ['genre', 'region', 'year'].map(key => String(filters[key] || '').slice(0, 100)).filter(Boolean).join(','));
  }
  const data = json((await resource(url.href, { headers: config.headers, signal, timeout: 10000 })).text);
  const items = data.subject_collection_items || data.items || data.subjects;
  if (!Array.isArray(items)) throw new Error('片单接口未返回影片列表，请稍后重试');
  const rows = items.filter(item => item.id && item.title).map(item => ({
    vod_id: 'https://movie.douban.com/subject/' + encodeURIComponent(item.id) + '/', vod_name: String(item.title),
    vod_pic: item.pic?.large || item.pic?.normal || item.cover_url || item.cover,
    vod_remarks: item.rating?.value ? '豆瓣 ' + item.rating.value : '暂无评分',
    vod_year: item.year || /^(\d{4})/.exec(item.card_subtitle || '')?.[1] || '', searchTitle: String(item.title),
  }));
  remember(site, rows);
  return { class: classes, filters: definitions(), list: rows, page, pagecount: Math.max(page, Math.ceil((Number(data.total) || rows.length) / 20)), total: Number(data.total) || rows.length, notice: '点击片单直接查找可播放片源；片名和评分由豆瓣提供。' };
}
module.exports = { list, definitions, classes };
