#!/usr/bin/env node
/* 抓一次换台过程中页面发出的真实媒体请求。
   目的：如果 m3u8 地址是页面自己算出来、能稳定复现的，那「自研播放器」这条路才可行；
         如果带一次性签名 / 依赖站点私有协议，那这条路基本封死。

   ⚠️ 上一版挂死的真因：ws.onmessage 被赋值了两次，第二次把「处理 pending 响应」的
      那个处理器整个覆盖掉了 → send() 永远不 resolve → 第一个 await 就挂住 → 2 分钟
      超时被 SIGTERM（exit 137，且没有任何输出）。现在合成一个 handler，并且给每个
       CDP 调用加超时，保证最坏情况是报错而不是挂死。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const CDP = 'http://127.0.0.1:9222';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

const targets = await (await fetch(CDP + '/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) { console.log('找不到 yangshipin 页面 target，现有：', targets.map(t => t.url).join(' | ')); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
const seen = [];

ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Network.requestWillBeSent') {
    const u = m.params.request.url;
    if (/\.m3u8|\.ts|\.flv|\.mp4|\/live\/|playlist|manifest|stream/i.test(u)) {
      seen.push({ u, m: m.params.request.method, h: Object.keys(m.params.request.headers || {}) });
    }
  }
};

/* 每个 CDP 调用最多等 8 秒，超时就 reject —— 不能再出现「无声挂死」 */
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时 8s`)); }, 8000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

try {
  await send('Network.enable');
  await ev(`(function(){ window.__lagProbe = { t0: performance.now(), events: [], srcSeen: 0, jsMs: 0, d: 0 }; return 1; })()`);
  adb('shell', 'input', 'keyevent', '20');
  await sleep(4000);
} catch (e) {
  console.log('采集阶段出错：', e.message);
}

console.log('=== 换台时页面发出的媒体相关请求（去重后，最多 25 条）===');
const uniq = [...new Map(seen.map(s => [s.u.split('?')[0], s])).values()];
uniq.slice(0, 25).forEach(s => {
  console.log(`  [${s.m}] ${s.u.slice(0, 150)}`);
  console.log(`       头: ${s.h.join(', ').slice(0, 110)}`);
});
console.log(`\n合计 ${seen.length} 次请求 / ${uniq.length} 个不同路径`);
if (!uniq.length) console.log('  （一条都没抓到 —— 可能走 WebSocket，或播放器跑在 worker / 被挡在 CDP 视野外）');
ws.close();
