(() => {
  'use strict';
  const panel = document.querySelector('.player-options-panel'); if (!panel) return;
  const make = (tag, text, cls = '') => { const el = document.createElement(tag); if (text) el.textContent = text; el.className = cls; return el; };
  const label = make('label', '', 'ad-filter-toggle'), toggle = make('input'); toggle.type = 'checkbox'; toggle.id = 'adFilterEnabled';
  label.append(toggle, document.createTextNode('过滤视频广告'));
  const description = make('p', '自动读取订阅规则，保留原视频清晰度。', 'quality-note');
  const button = make('button', '过滤规则', 'text-button'); button.type = 'button'; button.id = 'adFilterSettings';
  const block = make('div', '', 'ad-filter-options'); block.append(label, description, button); panel.insertBefore(block, panel.querySelector('.options-buttons'));
  const dialog = make('dialog', '', 'app-dialog'); dialog.id = 'adFilterDialog'; dialog.setAttribute('aria-labelledby', 'adFilterTitle');
  const heading = make('h2', '广告过滤'); heading.id = 'adFilterTitle'; const close = make('button', '关闭', 'btn'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
  const head = make('div', '', 'ad-filter-header'); head.append(heading, close);
  const info = make('p', '', 'field-hint'), form = make('form'), field = make('label', '额外广告域名（每行一个）'), input = make('textarea'); input.id = 'adFilterDomains'; input.rows = 5; input.placeholder = 'ads.example.com'; field.htmlFor = input.id;
  const hint = make('p', '仅添加确定用于广告的域名。检测到规则删除过多内容时，会保留原播放列表。直播、特殊分段和画面内广告暂不自动裁剪。', 'field-hint');
  const result = make('p', '', 'library-status'); result.setAttribute('role', 'status'); const save = make('button', '保存并应用', 'btn btn-primary'); save.type = 'submit';
  form.append(field, input, hint, result, save); dialog.append(head, info, form); document.body.append(dialog);
  let settings;
  async function api(body) {
    const response = await fetch('/api/adfilter', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const value = await response.json(); if (!response.ok) throw new Error(value.error || '无法保存过滤设置'); return value;
  }
  function show(value) { settings = value; toggle.checked = value.enabled; info.textContent = `订阅：${value.subscriptionDomains} 个广告域名、${value.subscriptionRules} 组片段规则。累计过滤 ${value.stats.segments} 段，约 ${value.stats.seconds} 秒。`; }
  function reload() { document.dispatchEvent(new CustomEvent('mobiletv-adfilter-change')); }
  toggle.addEventListener('change', async () => { const enabled = toggle.checked; toggle.disabled = true; try { show(await api({ enabled })); reload(); } catch (error) { toggle.checked = settings?.enabled !== false; window.MobileTVUI?.toast(error.message); } finally { toggle.disabled = false; } });
  button.addEventListener('click', async () => { try { show(await api()); input.value = settings.domains.join('\n'); result.textContent = ''; dialog.showModal(); } catch (error) { window.MobileTVUI?.toast(error.message); } });
  form.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true; try { show(await api({ domains: input.value })); dialog.close(); reload(); window.MobileTVUI?.toast('广告过滤规则已保存'); } catch (error) { result.textContent = error.message; } finally { save.disabled = false; } });
  api().then(show).catch(() => { toggle.checked = false; description.textContent = '过滤服务暂未连接，可刷新后重试。'; });
})();
