#!/usr/bin/env node
/* 在「已被敲死」的播放器上依次试几种救活手段，找出最轻的那个。
   判活：readyState>=3 且 currentTime 在 1.5s 内前进。 */
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
const health = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({rs:v.readyState,ns:v.networkState,src:(v.src||'').length,ct:Math.round(v.currentTime*100)/100});})()`) || '{}');
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

/* 等 1.5s，看 currentTime 是否前进 */
async function revived() {
  const a = await health();
  await sleep(1500);
  const b = await health();
  return b.ct > a.ct && b.rs >= 3;
}

console.log('准备干净页面…');
await ev('location.reload()');
await sleep(9000);
console.log('重载后:', JSON.stringify(await health()));

console.log('\n敲死它（6 连按，120ms 间隔）…');
for (let i = 0; i < 6; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
await sleep(4000);
const dead = await health();
console.log('当前状态:', JSON.stringify(dead), '→', isDead(dead) ? '已死' : '还活着（本次没敲成，换一批再试）');
if (!isDead(dead)) { ws.close(); process.exit(0); }

const clickRow = `(function(){var rs=document.querySelectorAll('.tv-main-con-r-list-left > *');for(var i=0;i<rs.length;i++){if(rs[i].offsetParent){var r=rs[i];['mousedown','mouseup','click'].forEach(function(n){r.dispatchEvent(new MouseEvent(n,{bubbles:true,cancelable:true,view:window,button:0}))});return i;}}return -1})()`;

const candidates = [
  ['① 原生点击当前行', clickRow],
  ['② video.load() 后再点击', `(function(){document.querySelector('video').load();${clickRow};return 1})()`],
  ['③ video.play()', `(function(){var p=document.querySelector('video').play();return p?1:0;})()`],
  ['④ 派发 resize 事件', `(function(){window.dispatchEvent(new Event('resize'));document.querySelector('video').dispatchEvent(new Event('resize'));return 1;})()`],
  ['⑤ 清空 src 再置回（如有旧值）', `(function(){var v=document.querySelector('video');var s=v.src;v.removeAttribute('src');v.load();if(s){v.src=s;}return 1;})()`]
];

for (const [name, code] of candidates) {
  if (!isDead(await health())) { console.log(`${name}：前面已经救活，跳过`); continue; }
  console.log(`${name} …`);
  try { await ev(code); } catch (e) { console.log('   执行出错:', e.message); }
  const ok = await revived();
  console.log(`   → ${ok ? '救活了' : '无效'}   ${JSON.stringify(await health())}`);
  if (ok) break;
}

if (isDead(await health())) {
  console.log('\n以上都不行，最后手段 location.reload() …');
  await ev('location.reload()');
  await sleep(9000);
  console.log('reload 后:', JSON.stringify(await health()), '→', isDead(await health()) ? '仍死' : '救活');
}
ws.close();
