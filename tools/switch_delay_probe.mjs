#!/usr/bin/env node
/* ============================================================
   换台手感对照实验（TV API 34）

   对比两种「延迟换台」方案，看哪个真的更不卡：
     A. 固定延迟：按下去等 N 毫秒就换（用户提议的 1 秒）
     B. 防抖：连续按只动光标，停下来 N 毫秒后换最后一台

   量的不只是「有没有卡」，还有：
     · 从「停下按键」到「画面出来」的实际耗时（这才是用户感受到的延迟）
     · 中途改主意时，误切了几次（固定延迟会切好几次，防抖只切一次）

   ⚠️ 主界面依赖央视频站出画。本轮跑之前先确认站片区在播 ——
      站挂了就直接跳过（不是本实验要验的东西）。
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PORT = 9222;
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a],
  { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

let ws, seq = 0; const pend = new Map();
async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/json`)).text()))
        .filter(t => t.type === 'page');
      if (list.length) {
        ws = new WebSocket(list[0].webSocketDebuggerUrl);
        await new Promise(r => ws.addEventListener('open', r));
        ws.addEventListener('message', e => {
          const m = JSON.parse(e.data);
          if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
        });
        return true;
      }
    } catch (e) {}
    await sleep(500);
  }
  return false;
}
const ev = expr => {
  const id = ++seq;
  return new Promise(res => {
    pend.set(id, m => res(m.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
};
const key = k => { adb('shell', 'input', 'keyevent', k); };

/** 等画面真的出来（video 有画面尺寸），返回等了多少毫秒 */
async function waitPicture(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await ev(`(function(){
      var v = document.querySelector('.tv-main-con-l video');
      return !!(v && v.videoWidth > 0);
    })()`);
    if (ok === true) return Date.now() - t0;
    await sleep(120);
  }
  return -1;
}

if (!await cdp()) { console.error('WebView 没起来'); process.exit(1); }

/* 确认主界面真的在播 */
adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP').toString();
await ev('__yspTV.closePanel()');
await sleep(300);
{
  const n = await ev('__yspTV && __yspTV.count()');
  if (!n) { console.log('主页��没起来，先跳过'); process.exit(2); }
  const w = await ev(`(function(){
    var v=document.querySelector('.tv-main-con-l video'); return v?v.videoWidth:0; })()`);
  if (!w) {
    console.log('⚠️央视频站没出画（站点侧问题），本轮跳过 —— 不是本实验要验的东西。');
    process.exit(2);
  }
}

console.log('\n=== 换台手感对照 ===\n');
const rows = [];
const n = await ev('__yspTV.count()');
console.log(`站点频道数：${n}\n`);

for (const gap of [0, 300, 600, 1000]) {
  await ev(`__yspTV.setSwitchGap(${gap})`);
  await sleep(300);
  // 连按 3 次下键（模拟用户快速翻台），记下「停下之后」到出画用了多久
  key('KEYCODE_DPAD_DOWN');
  await sleep(260);
  key('KEYCODE_DPAD_DOWN');
  await sleep(260);
  const t0 = Date.now();
  key('KEYCODE_DPAD_DOWN');
  const toPicture = await waitPicture();
  const total = Date.now() - t0;
  rows.push({ gap, toPicture, total });
  console.log(`  阀门 ${String(gap).padStart(4)}ms → 停下按键后 ${String(toPicture).padStart(6)}ms 出画（这一轮总耗时 ${total}ms）`);
  await sleep(2500);
}

console.log('\n=== 对照结论 ===');
for (const r of rows) {
  console.log(`  阀门 ${r.gap}ms：停下按键 → 出画 ${r.toPicture}ms` +
    (r.toPicture < 0 ? '（没出画）' : ''));
}
ws.close();
process.exit(0);
