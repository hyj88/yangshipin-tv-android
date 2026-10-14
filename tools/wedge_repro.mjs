#!/usr/bin/env node
/* 可复现地敲死站点播放器。
   关键修正：必须保证起点在【列表中段】。之前在列表末尾（第 32/33 行）按 DOWN，
   clamp 直接吃掉，全是空操作 —— 那样的「0/8 没敲死」是假象。
   做法：切到 CCTV tab（pid=600108442 的台在顶部附近）→ 等它落定 → 连按。 */
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
const errs = [];
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 120));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 120));
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 20000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const health = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({idx:__yspTV.index(),playing:__yspTV.playing(),rows:__yspTV.count(),rs:v.readyState,ns:v.networkState,src:(v.src||'').length,paused:v.paused,ct:Math.round(v.currentTime*100)/100});})()`) || '{}');
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

const TRIALS = Number(process.argv[2] || 3);
let dead = 0;
for (let t = 1; t <= TRIALS; t++) {
  await send('Runtime.enable');
  await ev('location.reload()');
  await sleep(8000);
  // 切到 CCTV tab，保证 playing 落在列表中段
  await ev('__yspTV.switchTab(0)');
  await sleep(4000);
  const start = await health();
  errs.length = 0;
  for (let i = 0; i < 6; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
  await sleep(5000);
  const after = await health();
  const d = isDead(after);
  if (d) dead++;
  console.log(`第 ${t}/${TRIALS} 轮：起点 idx=${start.idx} playing=${start.playing} rows=${start.rows} → 终点 idx=${after.idx} playing=${after.playing} | ${d ? '播放器死亡' : '存活'} | rs=${after.rs} ct=${after.ct} | detachMedia 类报错 ${errs.filter(e => /detachMedia|moduleActive/.test(e)).length} 条`);
}
console.log(`\n汇总：${TRIALS} 轮敲死 ${dead} 轮`);
ws.close();
