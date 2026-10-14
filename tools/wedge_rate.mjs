#!/usr/bin/env node
/* 量化「6 连按（120ms 间隔）把站点播放器敲死」的概率。
   每轮：重载拿干净页面 → 等播起来 → 6 连按 → 等 4s → 判活/判死。
   间歇性竞态必须用重复试验说话，单次结果没有意义。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) { console.log('找不到页面 target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 20000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const health = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({rs:v.readyState,ns:v.networkState,src:(v.src||'').length,ct:Math.round(v.currentTime*100)/100});})()`) || '{}');
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

const TRIALS = 8;
let dead = 0;
for (let t = 1; t <= TRIALS; t++) {
  await ev('location.reload()');
  await sleep(8000);
  const before = await health();
  if (isDead(before)) { await sleep(4000); }
  for (let i = 0; i < 6; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
  await sleep(4000);
  const after = await health();
  const d = isDead(after);
  if (d) dead++;
  console.log(`第 ${t}/${TRIALS} 轮：${d ? '播放器死亡' : '存活'}   rs=${after.rs} ns=${after.ns} src=${after.src} ct=${after.ct}`);
}
console.log(`\n汇总：${TRIALS} 轮里敲死 ${dead} 轮（${Math.round(dead / TRIALS * 100)}%）`);
ws.close();
