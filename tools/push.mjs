#!/usr/bin/env node
/* 把 tools/inject.css + tools/inject.js 热更进正在运行的 WebView
   （免去每次改样式都重编 APK）

   用法: node push.mjs
   原理: 直接改 <style id="ysp-tv-style"> 的 textContent；
         删掉 window.__yspTV 再重跑脚本（脚本首行有 `if (window.__yspTV) return` 幂等锁）。
*/
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const css = readFileSync(path.join(ROOT, 'tools', 'inject.css'), 'utf8');
const js = readFileSync(path.join(ROOT, 'tools', 'inject.js'), 'utf8');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) { console.error('无页面目标'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

async function ev(expression, label) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const res = r.result || {};
  if (res.exceptionDetails) {
    console.error(`❌ [${label}] JS 异常:`, JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails, null, 2));
    return null;
  }
  return res.result ? res.result.value : undefined;
}

const r1 = await ev(`(function(){
  var s = document.getElementById('ysp-tv-style');
  if (!s) { s = document.createElement('style'); s.id = 'ysp-tv-style'; document.head.appendChild(s); }
  s.textContent = ${JSON.stringify(css)};
  return 'css ' + s.textContent.length + ' chars';
})()`, 'css');
console.log('css →', r1);

await ev(`(function(){ try { delete window.__yspTV; } catch(e) { window.__yspTV = undefined; } return 1; })()`, 'reset');
const r2 = await ev(js + '\n;typeof window.__yspTV;', 'js');
console.log('js  →', r2 === 'object' ? '__yspTV 已重新挂载 ✅' : '结果异常: ' + r2);

// 等 boot 跑完再报告一次状态
await new Promise(r => setTimeout(r, 2500));
const st = await ev(`(function(){
  var T = window.__yspTV; if (!T) return 'no __yspTV';
  var l = document.querySelector('.tv-main-con-r-list-left');
  var rs = [];
  var n = T.count();
  var es = document.querySelector('.tv-main-con-r-list-left');
  var vis = [].slice.call(es.children).filter(function(r){ return r.offsetParent !== null; });
  return JSON.stringify({
    count: n,
    rowH: +T.rowHeight().toFixed(3),
    listH: es.clientHeight,
    rowsPerView: +(es.clientHeight / T.rowHeight()).toFixed(4),
    scrollTop: Math.round(es.scrollTop),
    firstVisibleTop: Math.round(vis[0].getBoundingClientRect().top - es.getBoundingClientRect().top)
  });
})()`, 'state');
console.log('state →', st);

ws.close();
