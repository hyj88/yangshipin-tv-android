#!/usr/bin/env node
/* ============================================================
   浏览器能力矩阵实验 —— 定位这个站点「最低需要什么内核」

   为什么做：
     安卓电视 4.4.2 = API 19 = WebView Chromium 30，且不可升级
     （独立 WebView/Chrome 更新只支持 5.0+）。
     站点播放器硬依赖 MediaSource(MSE)，而 MSE 是引擎能力，polyfill 不了。
     权威资料记录 MSE 在 Android WebView 上是 4.4.3(Chromium 33) 才支持 ——
     用户的 4.4.2 正好差一点点。

     光看资料不够，还要知道「少了哪一项会真的挂」。做法：在现代内核里逐个
     摘掉目标能力（等价复现老浏览器的处境），重载页面看 <video> 还有没有画面。
     这样得到的是「最低可用内核门槛」的实测结论，而不是猜测。

   判读要点：
     对照组 <video> 的 src 是 blob: 开头的 URL —— 这就是 MSE 在喂流。
     所以有没有 MSE，直接决定有没有画面。

   用法：
     node tools/browser_capability_probe.mjs              # TV 模拟器(9222)
     PORT=9223 node tools/browser_capability_probe.mjs    # 手机模拟器
   ============================================================ */
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.env.PORT || '9222';
const CDP = `http://127.0.0.1:${PORT}`;

/* 每个阶段：key、说明、要摘掉的东西、该能力首次可用的 Chrome 版本 */
const PHASES = [
  { key: 'control', label: '对照组（什么都不摘）', kill: [], since: '—' },
  { key: 'MSE',     label: '摘掉 MediaSource（MSE）', kill: ['MediaSource', 'WebKitMediaSource', 'ManagedMediaSource'], since: 'Chrome 23 / WebView 4.4.3' },
  { key: 'WASM',    label: '摘掉 WebAssembly',        kill: ['WebAssembly'], since: 'Chrome 57' },
  { key: 'fetch',   label: '摘掉 fetch',              kill: ['fetch'],       since: 'Chrome 42' },
  { key: 'Promise', label: '摘掉 Promise',            kill: ['Promise'],     since: 'Chrome 32' },
];

const targets = await (await fetch(CDP + '/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url)) || targets.find(t => t.type === 'page');
if (!page) { console.error('找不到页面目标：', JSON.stringify(targets)); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
let consoleMsgs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    consoleMsgs.push('[exception] ' + (d.exception?.description || d.text || '').split('\n')[0]);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level !== 'verbose') {
    consoleMsgs.push(`[${m.params.entry.level}] ${m.params.entry.text}`.slice(0, 170));
  }
};
const send = (method, params = {}) => {
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
};
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return null;
  return r.result?.result?.value;
}

const PROBE = `JSON.stringify((function () {
  var v = document.querySelector('.tv-main-con-l video') || document.querySelector('video');
  var killed = (window.__killed || []).join(',');
  return {
    killed: killed,
    src: v ? String(v.currentSrc || v.src || '').slice(0, 46) : '(无 video)',
    videoWidth: v ? v.videoWidth : -1,
    readyState: v ? v.readyState : -1,
    currentTime: v ? Math.round(v.currentTime * 10) / 10 : -1,
    body: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 70)
  };
})())`;

const killSrc = keys => `
(function () {
  window.__killed = ${JSON.stringify(keys)};
  ${JSON.stringify(keys)}.forEach(function (k) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: true, writable: true }); } catch (e) {}
  });
})();
`;

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

console.log('设备:', PORT === '9222' ? 'TV 模拟器' : '手机模拟器', ' CDP', PORT);
console.log('说明：对照组 video.src 以 blob: 开头 = MSE 在喂流\n');

const rows = [];
let currentInjection = null;

for (const ph of PHASES) {
  // 清掉上一阶段的注入
  if (currentInjection) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: currentInjection });
    currentInjection = null;
  }
  if (ph.kill.length) {
    const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: killSrc(ph.kill) });
    currentInjection = r.result?.identifier || null;
  }

  consoleMsgs = [];
  await send('Page.reload', { ignoreCache: false });
  await sleep(ph.key === 'control' ? 14000 : 18000);

  const st = JSON.parse((await ev(PROBE)) || '{}');
  const errors = consoleMsgs.filter(m => /exception|error/i.test(m)).slice(0, 2);

  rows.push({ ph, st, errors });
  console.log(`【${ph.key}】${ph.label}`);
  console.log(`   src=${st.src}  videoWidth=${st.videoWidth}  readyState=${st.readyState}  t=${st.currentTime}s`);
  console.log(`   画面: ${st.videoWidth > 0 ? '✅ 有' : '❌ 无'}   页面文字: ${st.body}`);
  if (errors.length) errors.forEach(e => console.log('   ' + e));
  console.log('');
}

/* ---- 清理 ---- */
if (currentInjection) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: currentInjection });
await send('Page.reload', { ignoreCache: false });
await sleep(4000);
ws.close();

/* ---- 判读 ---- */
const ctrl = rows[0].st;
console.log('='.repeat(68));
if (!(ctrl && ctrl.videoWidth > 0)) {
  console.log('对照组就没出画面 —— 实验前提不成立，先确认页面能正常播放再重跑。');
  process.exit(1);
}
console.log('画面对照（✅ 有 / ❌ 无）：');
const missing = [];
for (const r of rows) {
  const ok = r.st.videoWidth > 0;
  const tag = r.ph.key === 'control' ? '（基准）' : (ok ? '→ 不是硬需求' : '→ 硬需求！缺了就黑屏');
  console.log(`  ${ok ? '✅' : '❌'} 摘掉 ${r.ph.key.padEnd(9)} ${tag}   需要 ${r.ph.since}`);
  if (!ok && r.ph.key !== 'control') missing.push(r.ph);
}
console.log('');
console.log('结论：这个站点要跑起来，内核【必须】具备：');
console.log('      ' + missing.map(m => `${m.ph?.key || m.key}(${m.ph?.since || m.since})`).join('  '));
console.log('      对应最低内核 = ' + missing.map(m => m.ph?.since || m.since).join(' / '));
console.log('='.repeat(68));
