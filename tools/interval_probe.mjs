#!/usr/bin/env node
/* 扫「两次换台的最小安全间隔」。
   对每个候选间隔：按 DOWN → 等 interval → 再按 DOWN → 3 秒后看播放器是死是活。
   播放器判死：readyState===0 或 src 为空 或 networkState===0（且持续 3 秒）。
   目的是给 inject.js 的换台节流常量一个实测依据，而不是猜。 */
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
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 15000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const health = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({rs:v.readyState,ns:v.networkState,src:(v.src||'').length,ct:Math.round(v.currentTime*100)/100,playing:__yspTV.playing()});})()`) || '{}');
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

async function freshPage() {
  await ev('location.reload()');
  await sleep(9000);
  const h = await health();
  if (isDead(h)) { await sleep(4000); }
}

const intervals = [200, 400, 600, 900, 1200, 1600];
const results = [];
for (const ms of intervals) {
  await freshPage();
  adb('shell', 'input', 'keyevent', '20');
  await sleep(ms);
  adb('shell', 'input', 'keyevent', '20');
  await sleep(3000);
  const h = await health();
  const dead = isDead(h);
  results.push({ ms, dead, h });
  console.log(`间隔 ${String(ms).padStart(4)}ms → ${dead ? '播放器死亡' : '存活'}   (rs=${h.rs} ns=${h.ns} src=${h.src} ct=${h.ct} playing=${h.playing})`);
}

console.log('\n=== 汇总 ===');
results.forEach(r => console.log(`  ${String(r.ms).padStart(4)}ms  ${r.dead ? '死' : '活'}`));
const firstSafe = results.find(r => !r.dead);
console.log(firstSafe ? `\n最小安全间隔 ≈ ${firstSafe.ms}ms` : '\n所有间隔都死 —— 需要另一条路（例如换台前先 detach 或直接 reload）');
ws.close();
