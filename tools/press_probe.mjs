#!/usr/bin/env node
/* 量「连按 6 次」时视频管线到底在干什么。
   同时记录：我们的 move() 何时跑、video.src 何时变、各媒体事件何时来。
   目的：决定「按键合并」应该走  debounce（等静默再发车）
                           还是 coalesce（落地后补发最后一次）。 */
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
  const timer = setTimeout(() => { pending.delete(id.id || id); rej(new Error(`${method} 超时`)); }, 10000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

const INSTALL = `(function(){
  window.__pp = { log: [], srcPoll: null, lastSrc: '' };
  var v = document.querySelector('video');
  if (!v) return 'no video';
  ['loadstart','loadeddata','canplay','playing','waiting','emptied','abort','stalled','suspend'].forEach(function(n){
    v.addEventListener(n, function(){ window.__pp.log.push({ t: Math.round(performance.now()), e: n }); }, true);
  });
  var origMove = window.__yspTV.move;
  window.__yspTV.move = function(d){
    var r = origMove(d);
    window.__pp.log.push({ t: Math.round(performance.now()), e: 'move(' + d + ')=' + r });
    return r;
  };
  window.__pp.srcPoll = setInterval(function(){
    var s = (v.src || '').slice(0, 24);
    if (s !== window.__pp.lastSrc) {
      window.__pp.lastSrc = s;
      window.__pp.log.push({ t: Math.round(performance.now()), e: 'src=' + s });
    }
  }, 16);
  return 'ok';
})()`;

try {
  console.log('安装探针:', await ev(INSTALL));
  await ev(`window.__pp.log.length = 0; performance.now()`);
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    adb('shell', 'input', 'keyevent', '20');       // DOWN
    await sleep(120);
  }
  console.log(`6 次按键发完（每次间隔 120ms，共 ${Date.now() - t0}ms）`);
  await sleep(7000);
} catch (e) { console.log('出错：', e.message); }

const log = JSON.parse(await ev('JSON.stringify(window.__pp.log)') || '[]');
console.log('\n=== 时间线（t = 相对于清空日志的时刻，ms）===');
log.forEach(r => console.log(`  +${String(r.t).padStart(6)}  ${r.e}`));
console.log(`\n共 ${log.length} 条事件`);

const moves = log.filter(r => r.e.startsWith('move(')).length;
const srcs = log.filter(r => r.e.startsWith('src=')).length;
const loaded = log.filter(r => r.e === 'loadeddata').length;
const playing = log.filter(r => r.e === 'playing').length;
const waiting = log.filter(r => r.e === 'waiting').length;
console.log(`\n汇总：move() 调用 ${moves} 次 | video.src 变更 ${srcs} 次 | loadeddata ${loaded} 次 | playing ${playing} 次 | waiting ${waiting} 次`);
console.log('当前播放下标:', await ev('__yspTV.playing()'), ' 光标:', await ev('__yspTV.index()'));
ws.close();
