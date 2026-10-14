#!/usr/bin/env node
/* 手机端「点具体频道行」这条换台路径的风险实测。
   已知：上下滑动走 move()，已被 1.7 的阀门保护；只有 tapRow → 浏览器原生 click
   这条路绕过阀门。但它有自限性：点完一行面板就收起，必须再点一次屏幕才能点下一行。
   这里模拟「能多快就多快」的 点开面板→点行 循环，看播放器会不会被敲死。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5556';
const CDP = 'http://127.0.0.1:9223';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

async function cdp() {
  const targets = await (await fetch(CDP + '/json')).json();
  const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
  if (!page) return null;
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
  const snap = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({idx:__yspTV.index(),playing:__yspTV.playing(),rows:__yspTV.count(),rs:v.readyState,ns:v.networkState,src:(v.src||'').length,paused:v.paused,ct:Math.round(v.currentTime*100)/100});})()`) || '{}');
  return { ws, send, ev, snap };
}
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

/* 冷启动 */
adb('shell', 'am', 'force-stop', 'com.ysptv.player');
await sleep(1500);
adb('shell', 'am', 'start', '-n', 'com.ysptv.player/.MainActivity');
await sleep(4000);
const pid = adb('shell', 'pidof', 'com.ysptv.player').trim();
adb('forward', 'tcp:9223', 'localabstract:webview_devtools_remote_' + pid);
const c = await cdp();
if (!c) { console.log('找不到页面'); process.exit(1); }
await c.send('Runtime.enable');

let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  await sleep(700);
  const h = await c.snap();
  if (h.rs >= 3 && h.paused === false && h.ct > 0.5) ok = true;
}
console.log('冷启动后:', JSON.stringify(await c.snap()));

/* 拿前 8 行的中心坐标。
   ⚠️ getBoundingClientRect 是 CSS 像素，adb input tap 是设备像素，差一个
      devicePixelRatio —— 不乘这个，点全都落空，测出来的"没换台"是假象。 */
const rects = JSON.parse(await c.ev(`(function(){
  var dpr = window.devicePixelRatio || 1;
  var rs = document.querySelectorAll('.tv-main-con-r-list-left > *');
  var out = [];
  for (var i = 0; i < Math.min(rs.length, 10); i++) {
    var r = rs[i].getBoundingClientRect();
    if (r.height > 1 && r.width > 1) out.push({ x: Math.round((r.left + r.width/2) * dpr), y: Math.round((r.top + r.height/2) * dpr) });
  }
  return JSON.stringify({dpr: dpr, vw: innerWidth, vh: innerHeight, rows: out});
})()`) || '{}');
console.log(`DPR=${rects.dpr} 视口=${rects.vw}x${rects.vh}（设备像素 ${Math.round(rects.vw * rects.dpr)}x${Math.round(rects.vh * rects.dpr)}），取到 ${rects.rows.length} 个行`);

/* 屏幕中心（点它 = 打开/收起面板），同样要乘 DPR */
const cx = Math.round(rects.vw / 2 * rects.dpr), cy = Math.round(rects.vh / 2 * rects.dpr);

/* ⚠️ 必须先【打开面板】再量行坐标：面板是用 transform 藏起来的（见 README §8），
   收起状态下 getBoundingClientRect 给出的是屏幕外坐标，照着点全都落空。 */
adb('shell', 'input', 'tap', String(cx), String(cy));
await sleep(700);
const open = await c.ev('__yspTV.isPanelOpen()');
console.log(`面板打开状态：${open}`);
const rowsPos = JSON.parse(await c.ev(`(function(){
  var dpr = window.devicePixelRatio || 1;
  var rs = document.querySelectorAll('.tv-main-con-r-list-left > *');
  var out = [];
  for (var i = 0; i < Math.min(rs.length, 12); i++) {
    var r = rs[i].getBoundingClientRect();
    if (r.height > 1 && r.width > 1 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1) {
      out.push({ x: Math.round((r.left + r.width/2) * dpr), y: Math.round((r.top + r.height/2) * dpr) });
    }
  }
  return JSON.stringify(out);
})()`) || '[]');
console.log(`面板展开后取到 ${rowsPos.length} 个可见行的坐标`);

const CYCLES = Number(process.argv[2] || 8);
console.log(`\n开始 ${CYCLES} 轮「点一行换台 → 点屏幕重开面板」，能多快多快：`);
for (let i = 0; i < CYCLES; i++) {
  const r = rowsPos[(i * 3) % rowsPos.length];
  adb('shell', 'input', 'tap', String(r.x), String(r.y));    // 点一行（点完面板自动收起）
  await sleep(150);
  const h = await c.snap();
  console.log(`  第 ${i + 1} 轮：playing=${h.playing} rs=${h.rs} paused=${h.paused} ct=${h.ct}${isDead(h) ? '  ← 看着像死' : ''}`);
  if (i < CYCLES - 1) { adb('shell', 'input', 'tap', String(cx), String(cy)); await sleep(450); }   // 重开面板
}

let alive = null, deadRun = 0;
for (let k = 0; k < 30; k++) {
  await sleep(500);
  const h = await c.snap();
  if (h.rs >= 3 && h.ct > 0.5 && h.paused === false) { alive = h; break; }
  if (isDead(h)) { deadRun++; if (deadRun >= 6) break; } else deadRun = 0;
}
console.log(`\n结局：${alive ? `存活 rs=${alive.rs} ct=${alive.ct} playing=${alive.playing}` : `持续死亡（连续 ${deadRun} 次采样）`}`);
c.ws.close();
