#!/usr/bin/env node
/* B 路径第二步：不靠 CDP 抓包，直接在页面里 hook fetch / XHR，
   把站点自己「换台时」拿到的 get_live_info 响应原样读出来。
   这同时验证 B 方案的核心手段是否可行：** eavesdrop（窃听）站点自己的播放地址**，
   不需要逆它的签名算法。 */
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

/* 等播起来 */
for (let i = 0; i < 25; i++) {
  await sleep(700);
  const h = JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({rs:v.readyState,ct:Math.round(v.currentTime*100)/100,paused:v.paused});})()`) || '{}');
  if (h.rs >= 3 && h.paused === false && h.ct > 0.5) break;
}

/* 装钩子：fetch + XHR，只记 player-api 的请求与响应 */
const HOOK = `(function(){
  if (window.__eaves) return 'already';
  window.__eaves = { reqs: [], resps: [] };
  var of = window.fetch;
  window.fetch = function(){
    try {
      var u = (typeof arguments[0] === 'string') ? arguments[0] : (arguments[0] && arguments[0].url) || '';
      if (/player-api\\.yangshipin\\.cn/.test(u)) {
        window.__eaves.reqs.push({ url: u, body: (arguments[1] && arguments[1].body) ? String(arguments[1].body).slice(0,400) : '' });
      }
    } catch(e){}
    return of.apply(this, arguments).then(function(r){
      try {
        if (/player-api\\.yangshipin\\.cn/.test(r.url)) {
          r.clone().text().then(function(t){
            window.__eaves.resps.push({ url: r.url, status: r.status, body: t.slice(0, 3000) });
          });
        }
      } catch(e){}
      return r;
    });
  };
  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u){ this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b){
    try {
      if (this.__u && /player-api\\.yangshipin\\.cn/.test(this.__u)) {
        window.__eaves.reqs.push({ url: this.__u, method: this.__m || 'GET', body: b ? String(b).slice(0,400) : '' });
        this.addEventListener('load', function(){
          window.__eaves.resps.push({ url: this.__u, status: this.status, body: (this.responseText||'').slice(0, 3000) });
        });
      }
    } catch(e){}
    return os.apply(this, arguments);
  };
  return 'ok';
})()`;
console.log('装钩子:', await ev(HOOK));

/* 换两次台，多攒点样本 */
for (let k = 0; k < 2; k++) {
  console.log(`\n按一次 DOWN（第 ${k + 1} 次换台）…`);
  adb('shell', 'input', 'keyevent', '20');
  await sleep(5000);
}

const data = JSON.parse(await ev('JSON.stringify(window.__eaves)') || '{}');
console.log(`\n=== 窃听到 ${data.reqs.length} 个 player-api 请求 ===`);
data.reqs.forEach((r, i) => {
  console.log(`\n[请求 ${i + 1}] ${r.url}`);
  console.log(`  body: ${r.body}`);
  const resp = data.resps[i];
  if (resp) {
    console.log(`  → ${resp.status}`);
    try {
      const j = JSON.parse(resp.body);
      console.log('  → JSON 键: ' + Object.keys(j).join(', '));
      console.log('  → ' + JSON.stringify(j).slice(0, 1200));
    } catch (e) {
      console.log('  → 非 JSON，前 600 字符: ' + resp.body.slice(0, 600));
    }
  }
});
ws.close();
