#!/usr/bin/env node
/* 单次换台（间隔 3s，不给站点压力）连续 10 次，统计：
   - 多少次正常出画
   - 多少次把播放器敲死（readyState 卡 0 / src 空）
   结论决定：只做「按键合并」够不够，还是必须加「死锁看门狗 + 自恢复」。 */
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
    const d = m.params.exceptionDetails;
    errs.push((d.exception?.description || d.text || '').slice(0, 160));
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errs.push((m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 160));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 15000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

try {
  await send('Runtime.enable');
  await ev('location.reload()');
  await sleep(9000);
} catch (e) { console.log('准备阶段出错：', e.message); }

const N = 10;
const rows = [];
for (let i = 0; i < N; i++) {
  errs.length = 0;
  const t0 = Date.now();
  adb('shell', 'input', 'keyevent', '20');
  // 轮询等出画：readyState>=2 且 currentTime 前进
  let landed = -1, lastCt = -1;
  for (let k = 0; k < 40; k++) {
    await sleep(250);
    const s = JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({rs:v.readyState,ct:Math.round(v.currentTime*100)/100,src:(v.src||'').length});})()`) || '{}');
    if (s.rs >= 2 && s.ct > lastCt) { lastCt = s.ct; }
    if (s.rs >= 3 && s.ct > 0.5) { landed = Date.now() - t0; break; }
    if (s.rs === 0 && s.src === 0) { landed = -2; break; }   // 敲死
  }
  rows.push({ i: i + 1, landed, errs: errs.slice() });
  console.log(`第 ${String(i + 1).padStart(2)} 次换台：${landed > 0 ? landed + 'ms 出画' : (landed === -2 ? '播放器死亡' : '超时未出画')}${errs.length ? ' | 报错 ' + errs.length + ' 条' : ''}`);
  await sleep(2500);
}

const ok = rows.filter(r => r.landed > 0).length;
const dead = rows.filter(r => r.landed === -2).length;
const slow = rows.filter(r => r.landed <= 0 && r.landed !== -2).length;
console.log(`\n汇总：正常 ${ok}/${N}，敲死 ${dead}/${N}，超时未出画 ${slow}/${N}`);
console.log('\n所有报错明细：');
const all = rows.flatMap((r, i) => r.errs.map(e => `  第${i + 1}次: ${e}`));
console.log(all.length ? all.join('\n') : '  （无）');
ws.close();
