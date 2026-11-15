const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const WebSocket = require('ws');

async function browserDriver(profile) {
  const executable = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(file => fs.existsSync(file));
  if (!executable) throw new Error('This optional browser test requires Microsoft Edge on Windows.');
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Browser startup timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const socket = new WebSocket(endpoint), pending = new Map(); let sequence = 0;
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.on('message', raw => {
    const message = JSON.parse(raw), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const target = await command('Target.createTarget', { url: 'about:blank' });
  const session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable', {}, session);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, session);
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  return {
    evaluate,
    async navigate(url) { await command('Page.navigate', { url }, session); },
    async wait(expression, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { const value = await evaluate(expression); if (value) return value; await delay(150); }
      throw new Error('Browser condition timed out: ' + expression + '\n' + JSON.stringify(await evaluate('({page:document.title,error:document.querySelector("#libraryStatus")?.textContent,dialog:document.querySelector("#libraryDetailStatus")?.textContent,videoError:document.querySelector("video")?.error?.message})')));
    },
    async screenshot(file) { const result = await command('Page.captureScreenshot', { format: 'png' }, session); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(result.data, 'base64')); },
    async close() {
      if (socket.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} socket.close(); }
      if (child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2500)]); if (child.exitCode === null) child.kill(); }
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser closed')); }
    },
  };
}

module.exports = { browserDriver };
