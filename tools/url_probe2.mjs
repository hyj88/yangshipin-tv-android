#!/usr/bin/env node
/* url_probe 的第二轮：不截断、抓响应体、抓前置 API 调用，并验证 token 能否复现。 */
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

/* 全部请求按 host 归类；token 媒体请求单独留全量 */
const byHost = new Map();
const mediaReqs = [];      // {url, method, headers, reqId}
const responses = [];      // {reqId, url, status, mime}

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const r = m.params.request;
    let host = '(unknown)';
    try { host = new URL(r.url).host; } catch {}
    byHost.set(host, (byHost.get(host) || 0) + 1);
    if (/mobilelive|\.m3u8|\.ts(\?|$)|\.flv|\/live\/|playlist|manifest|\/ysp\//i.test(r.url)) {
      mediaReqs.push({ url: r.url, method: r.method, headers: r.headers || {}, reqId: m.params.requestId });
    }
  }
  if (m.method === 'Network.responseReceived') {
    const u = m.params.response.url;
    if (mediaReqs.some(q => q.reqId === m.params.requestId)) {
      responses.push({ reqId: m.params.requestId, url: u, status: m.params.response.status, mime: m.params.response.mimeType, remote: m.params.response.remoteIPAddress });
    }
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
  await ev(`(function(){ window.__lagProbe = { t0: performance.now(), events: [], srcSeen: 0, jsMs: 0, d: 0 }; return 1; })()`);
  adb('shell', 'input', 'keyevent', '20');       // 下一台
  await sleep(2500);
  adb('shell', 'input', 'keyevent', '19');       // 再上一台，回到原点，制造第二次换台
  await sleep(4000);
} catch (e) { console.log('采集阶段出错：', e.message); }

console.log('=== 请求按 host 归类 ===');
[...byHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .forEach(([h, n]) => console.log(`  ${String(n).padStart(4)}  ${h}`));

console.log('\n=== 媒体类请求全量（不截断）===');
for (const q of mediaReqs.slice(0, 8)) {
  console.log(`  [${q.method}] ${q.url}`);
  console.log(`       UA: ${String(q.headers['User-Agent'] || q.headers['user-agent']).slice(0, 90)}`);
  console.log(`       Referer: ${q.headers.Referer || q.headers.referer || '(无)'}`);
}
if (!mediaReqs.length) console.log('  （无）');

console.log('\n=== 媒体请求的响应 ===');
for (const r of responses.slice(0, 8)) {
  console.log(`  ${r.status} ${r.mime} ${r.remote || ''}`);
  console.log(`      ${r.url.slice(0, 120)}`);
  try {
    const body = await send('Network.getResponseBody', { requestId: r.reqId });
    const b64 = body.result?.body || '';
    const txt = Buffer.from(b64, 'base64').toString('utf8');
    console.log(`      响应体 ${txt.length} 字节，前 400 字符：`);
    console.log('      ' + txt.slice(0, 400).replace(/\n/g, '\n      '));
  } catch (e2) { console.log(`      （取响应体失败：${e2.message}）`); }
}
if (!responses.length) console.log('  （无）');
ws.close();
