#!/usr/bin/env node
/* B 路径第五步：抓 player-api 调用的**调用栈**，看是页面里哪个函数发起的。
   如果栈里能认出可调用的函数（比如 YspPlayer 的某个方法），
   「驱动页面自己的解析器去预取下一台」这条路就不用逆任何签名。 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PKG = 'com.ysptv.player';
const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

adb('shell', 'am', 'force-stop', PKG);
await sleep(1500);
adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity');
await sleep(4000);
const pid = adb('shell', 'pidof', PKG).trim();
adb('forward', 'tcp:9222', 'localabstract:webview_devtools_remote_' + pid);

let page = null;
for (let i = 0; i < 25 && !page; i++) {
  await sleep(700);
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
}
if (!page) { console.log('找不到页面'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 25000);
  pending.set(id, m => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

for (let i = 0; i < 25; i++) {
  await sleep(700);
  const h = JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({rs:v.readyState,ct:Math.round(v.currentTime*100)/100,paused:v.paused});})()`) || '{}');
  if (h.rs >= 3 && h.paused === false && h.ct > 0.5) break;
}

/* 装栈钩子：XHR open 时抓 stack，只留 player-api 的 */
await ev(`(function(){
  window.__st = [];
  var oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u){
    try {
      if (/player-api\\.yangshipin\\.cn/.test(u)) {
        var st = (new Error()).stack.split('\\n').slice(1, 12).map(function(l){ return l.trim(); });
        window.__st.push({ url: u, stack: st });
      }
    } catch(e){}
    return oo.apply(this, arguments);
  };
  return 1;
})()`);

console.log('按一次 DOWN…');
adb('shell', 'input', 'keyevent', '20');
await sleep(6000);

const st = JSON.parse(await ev('JSON.stringify(window.__st)') || '[]');
console.log(`\n抓到 ${st.length} 个 player-api 调用的栈：`);
st.forEach((s, i) => {
  console.log(`\n[${i + 1}] ${s.url}`);
  s.stack.forEach(l => {
    const clean = l.split('https:').join('<url>https:').replace(/(<url>https?:[^\s)]+)/g, '<url>');
    console.log('    ' + clean.slice(0, 190));
  });
});
ws.close();
