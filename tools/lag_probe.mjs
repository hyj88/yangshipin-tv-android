#!/usr/bin/env node
/* ============================================================
   量一下「按上下键换台」的时间到底花在哪一层。

   三段计时（全部用 performance.now()，同一时基）：
     t_js      move() 这一次 JS 调用本身要多久（我们自己的代码）
     t_src     从调用到 <video>.src 真的变（站点开始加载新流）
     t_play    从调用到画面重新出（video.playing 且 readyState>=3）
     t_first   从调用到第一帧可画（loadeddata / timeupdate 前进）

   另外单独量一次 Runtime.evaluate('1+1') 的往返 —— 它是 Java→WebView
   这条链的下限，如果它本身就慢，那才是壳子的问题。

   判读：
     · t_js 很小、t_play 很大  → 卡在站点 JS / MSE 重新缓冲，跟 Java 无关
     · evaluate('1+1') 就几百ms → 壳子（WebView 主线程）真的忙，那才该动 Java
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const CDP = 'http://127.0.0.1:9222';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

const targets = await (await fetch(CDP + '/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) { console.log('没有目标页'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
async function raw(expr) {
  const r = await ws.send && await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const res = r.result || {};
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result ? res.result.value : undefined;
}
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});

/* --- 1. Java→WebView 链路的下限 --- */
for (let i = 0; i < 3; i++) { const t = Date.now(); await raw('1+1'); console.log(`  evaluate('1+1') 往返 = ${Date.now() - t}ms`); }

/* --- 2. 装探针：记 video 事件 + 包住 move() --- */
await raw(`(function(){
  if (window.__lagProbe) return 'already';
  var v = document.querySelector('.tv-main-con-l video');
  if (!v) return 'no video';
  window.__lagProbe = { t0: 0, events: [], srcSeen: 0 };
  ['loadstart', 'loadeddata', 'playing', 'canplay', 'waiting'].forEach(function (n) {
    v.addEventListener(n, function () {
      if (!window.__lagProbe.t0) return;
      window.__lagProbe.events.push([n, +(performance.now() - window.__lagProbe.t0).toFixed(1)]);
    });
  });
  var T = window.__yspTV;
  var orig = T.move;
  T.move = function (d) {
    window.__lagProbe = { t0: performance.now(), events: [], srcSeen: 0, jsMs: 0, d: d };
    var t1 = performance.now();
    var r = orig(d);
    window.__lagProbe.jsMs = +(performance.now() - t1).toFixed(2);
    return r;
  };
  // src 变化另起一条轮询（loadstart 不一定每次都给）
  window.__lagPoll = setInterval(function () {
    var L = window.__lagProbe; if (!L || !L.t0) return;
    var v2 = document.querySelector('.tv-main-con-l video');
    if (v2 && v2.src && !L.srcSeen) { L.srcSeen = +(performance.now() - L.t0).toFixed(1); }
    if (L.events.some(function (e) { return e[0] === 'playing'; })) { clearInterval(window.__lagPoll); }
  }, 30);
  return 'ok';
})()`).then(r => console.log('  探针:', r));

const read = () => raw(`(function(){
  var L = window.__lagProbe;
  var v = document.querySelector('.tv-main-con-l video');
  return JSON.stringify({
    jsMs: L ? L.jsMs : null,
    srcSeen: L ? L.srcSeen : null,
    events: L ? L.events : [],
    now: v ? { rs: v.readyState, paused: v.paused, ct: +v.currentTime.toFixed(2), w: v.videoWidth } : null
  });
})()`);

console.log('\n=== 真按键（adb input keyevent，和用户一样）===');
for (let i = 0; i < 4; i++) {
  await raw(`(function(){ window.__lagProbe = { t0: performance.now(), events: [], srcSeen: 0, jsMs: 0, d: 0 }; return 1; })()`);
  const tKey = Date.now();
  adb('shell', 'input', 'keyevent', i % 2 === 0 ? '20' : '19');
  // 等到出现 playing 或 12 秒
  let r = null;
  for (let k = 0; k < 40; k++) {
    await sleep(300);
    r = JSON.parse(await read());
    if (r.events.some(e => e[0] === 'playing')) break;
  }
  const wall = Date.now() - tKey;
  const play = (r.events.find(e => e[0] === 'playing') || [null, null])[1];
  const first = (r.events.find(e => e[0] === 'loadeddata') || r.events.find(e => e[0] === 'canplay') || [null, null])[1];
  console.log(`  #${i} 按键→出画(墙钟) ${wall}ms  | move() 自身 ${r.jsMs}ms  | src 变 ${r.srcSeen}ms  | 首帧 ${first}ms  | playing ${play}ms  | 事件 ${JSON.stringify(r.events)}`);
}

console.log('\n=== 连续快按（模拟用户连按）===');
await raw(`(function(){ window.__lagProbe = { t0: performance.now(), events: [], srcSeen: 0, jsMs: 0, d: 0 }; return 1; })()`);
const tRush = Date.now();
for (let i = 0; i < 6; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
let rr = null;
for (let k = 0; k < 50; k++) { await sleep(300); rr = JSON.parse(await read()); if (rr.events.some(e => e[0] === 'playing')) break; }
console.log(`  连按 6 次 → 最后出画 ${Date.now() - tRush}ms  | 最后一次 move() 自身 ${rr.jsMs}ms  | 事件 ${JSON.stringify(rr.events)}`);

ws.close();
