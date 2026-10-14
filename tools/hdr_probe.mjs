#!/usr/bin/env node
/* B 路径第四步：用 CDP 的 requestWillBeSentExtraInfo 拿站点 player-api 请求的
   **完整请求头**，然后原样（带全头）重放，看 401 到底缺什么。
   JS hook 抓头会失败：setRequestHeader 在 open() 之后、send() 之前调用，
   在 send() 里才替换原型方法已经晚了。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync } from 'node:fs';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PKG = 'com.ysptv.player';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

adb('shell', 'am', 'force-stop', PKG);
await sleep(1500);
adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity');
await sleep(4000);
const pid = adb('shell', 'pidof', PKG).trim();
adb('forward', 'tcp:9222', 'localabstract:webview_devtools_remote_' + pid);

let page = null;
for (let i = 0; i < 25 && !page; i++) {
  await sleep(700);
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
}
if (!page) { console.log('找不到页面'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
const byReq = new Map();       // requestId → {url, method, headers, postData}
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    byReq.set(m.params.requestId, { url: r.url, method: r.method, headers: Object.assign({}, r.headers), postData: r.postData });
  }
  if (m.method === 'Network.requestWillBeSentExtraInfo') {
    const cur = byReq.get(m.params.requestId);
    if (cur) Object.assign(cur.headers, m.params.headers);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 25000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

for (let i = 0; i < 25; i++) {
  await sleep(700);
  const h = JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({rs:v.readyState,ct:Math.round(v.currentTime*100)/100,paused:v.paused});})()`) || '{}');
  if (h.rs >= 3 && h.paused === false && h.ct > 0.5) break;
}

await send('Network.enable');
console.log('按一次 DOWN…');
adb('shell', 'input', 'keyevent', '20');
await sleep(6000);

const api = [...byReq.values()].filter(q => /player-api\.yangshipin\.cn/.test(q.url));
console.log(`\n抓到 ${api.length} 个 player-api 请求`);
api.forEach((q, i) => {
  console.log(`\n[${i + 1}] ${q.method} ${q.url}`);
  console.log('  --- 请求头 ---');
  Object.keys(q.headers).sort().forEach(k => console.log(`    ${k}: ${String(q.headers[k]).slice(0, 150)}`));
  console.log(`  --- body（前 500）---\n    ${(q.postData || '').slice(0, 500)}`);
});
writeFileSync('/tmp/ysp_api.json', JSON.stringify(api, null, 2));
console.log('\n已存 /tmp/ysp_api.json');

/* 带全头重放第一个请求 */
const a = api.find(q => /auth/.test(q.url));
if (a) {
  console.log('\n=== 带全头原样重放 auth ===');
  const hdrs = {};
  Object.keys(a.headers).forEach(k => {
    const lk = k.toLowerCase();
    if (['host', 'content-length', 'connection', 'accept-encoding', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', ':method', ':authority', ':scheme', ':path'].includes(lk)) return;
    hdrs[k] = a.headers[k];
  });
  console.log('  实际发出的头: ' + Object.keys(hdrs).join(', '));
  let r = await fetch(a.url, { method: 'POST', headers: hdrs, body: a.postData });
  let raw = await r.text();
  console.log(`  ${r.status} 长度=${raw.length} 前 200: ${raw.slice(0, 200)}`);
}
ws.close();
