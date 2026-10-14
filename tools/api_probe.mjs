#!/usr/bin/env node
/* 第三轮：真正换一次台，抓全部网络请求，找出「token 从哪个 API 来」。
   前两轮的问题：没先开面板，keyevent 只够开面板、没真的换台，
   所以只拍到当前频道的稳态 m3u8 刷新。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const CDP = 'http://127.0.0.1:9222';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

const targets = await (await fetch(CDP + '/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) { console.log('找不到页面 target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();

const reqs = [];   // {t, method, url, postData}
let t0 = Date.now();

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    reqs.push({ dt: Date.now() - t0, method: r.method, url: r.url, post: (r.postData || '').slice(0, 200) });
  }
};

const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时 8s`)); }, 8000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

try {
  await send('Network.enable');
  const before = await ev(`(function(){ try { return JSON.stringify({panel: window.__yspTV.isPanelOpen(), idx: window.__yspTV.index(), entry: window.__yspTV.onEntry()}); } catch(e){ return 'ERR '+e.message; } })()`);
  console.log('换台前状态:', before);
  await ev(`(function(){ window.__yspTV.openPanel(); return 1; })()`);
  await sleep(300);
  reqs.length = 0; t0 = Date.now();
  adb('shell', 'input', 'keyevent', '20');   // DOWN → 真的换台
  await sleep(5000);
  const after = await ev(`(function(){ try { return JSON.stringify({panel: window.__yspTV.isPanelOpen(), idx: window.__yspTV.index()}); } catch(e){ return 'ERR '+e.message; } })()`);
  console.log('换台后状态:', after);
} catch (e) { console.log('采集阶段出错：', e.message); }

console.log('\n=== 换台期间的全部请求（按时间序）===');
reqs.forEach(r => {
  let short = r.url;
  try { const u = new URL(r.url); short = u.host + u.pathname + (u.search ? '?' + u.search.slice(0, 160) : ''); } catch {}
  console.log(`  +${String(r.dt).padStart(5)}ms [${r.method}] ${short}`);
  if (r.post) console.log(`           body: ${r.post}`);
});
console.log(`\n合计 ${reqs.length} 个请求`);
ws.close();
