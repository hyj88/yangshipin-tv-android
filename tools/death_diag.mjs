#!/usr/bin/env node
/* 诊断「加了节流后仍然会死、但没有 detachMedia 报错」的那种死法。
   单轮深挖：完整错误文本 + playing 跳变时间线 + 死亡前后的视频健康度。
   反复跑到复现为止（最多 6 轮）。 */
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
  if (m.method === 'Runtime.exceptionThrown') {
    errs.push({ k: 'uncaught', txt: (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').replace(/\s+/g, ' ').slice(0, 220) });
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    errs.push({ k: 'console.' + m.params.type, txt: (m.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ').replace(/\s+/g, ' ').slice(0, 220) });
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 20000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
const snap = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({idx:__yspTV.index(),playing:__yspTV.playing(),rows:__yspTV.count(),pend:__yspTV.switchPending(),gate:__yspTV.switchGateLeft(),rs:v.readyState,ns:v.networkState,src:(v.src||'').length,paused:v.paused,ct:Math.round(v.currentTime*100)/100});})()`) || '{}');
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

const t0 = Date.now();
const line = (tag, h) => console.log(`  +${String(Date.now() - t0).padStart(6)}ms ${tag.padEnd(10)} idx=${h.idx} playing=${h.playing} pend=${h.pend} gate=${h.gate} rs=${h.rs} ns=${h.ns} src=${h.src} ct=${h.ct}`);

for (let trial = 1; trial <= 6; trial++) {
  await send('Runtime.enable');
  await ev('location.reload()');
  await sleep(8000);
  await ev('__yspTV.switchTab(0)');
  await sleep(4000);
  const start = await snap();
  errs.length = 0;
  console.log(`\n===== 第 ${trial} 轮：起点 idx=${start.idx} playing=${start.playing} rows=${start.rows} =====`);
  for (let i = 0; i < 6; i++) {
    adb('shell', 'input', 'keyevent', '20');
    await sleep(120);
  }
  const after = await snap();
  line('按完', after);
  // 死亡前后每 250ms 采一次，共 10s
  let died = null;
  for (let k = 0; k < 40; k++) {
    await sleep(250);
    const h = await snap();
    if (isDead(h) && died === null) { died = Date.now() - t0; line('!! 死亡', h); }
  }
  const fin = await snap();
  console.log(`  结局：${isDead(fin) ? '死亡' : '存活'}  rs=${fin.rs} playing=${fin.playing}${died ? `（按完后 ${died - (Date.now() - t0 - 10000)}ms 前后死亡）` : ''}`);
  console.log(`  错误 ${errs.length} 条：`);
  errs.slice(0, 12).forEach(r => console.log(`    [${r.k}] ${r.txt}`));
  if (isDead(fin)) { console.log('\n*** 复现了，停止 ***'); break; }
}
ws.close();
