#!/usr/bin/env node
/* ============================================================
   hls.js 兼容性探针 —— 「自定义 m3u8 源」该走哪条路，用实测决定

   背景：自定义源要播 m3u8，但 WebView 里的 <video src="x.m3u8"> 是不行的
   （Chromium 没有原生 HLS，只有 Safari 有）。所以必须在两条路里选：

     路 A：hls.js（JS 把 TS 切片解复用后喂 MSE）—— 需要 MSE
     路 B：原生 MediaPlayer HLS —— 走平台解码器，不需要 MSE

   这个脚本测「路 A」在目标 WebView 里到底能不能跑：
   注入 hls.js 源码 → 建 <video> → attachMedia → loadSource → 轮询是否有画面。

   为什么值得实测：hls.js 各版本对老内核的兼容差异很大，
   而我们的设备谱系从 Chromium 37（API 21）一直到 Chromium 12x（API 34+）。

   用法：
     node tools/hls_probe.mjs                       # 默认 TV 9222 + 最新版 hls.js
     node tools/hls_probe.mjs --port 9223           # 手机
     node tools/hls_probe.mjs --hls /tmp/hls-0.14.17.min.js
   ============================================================ */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
let port = process.env.PORT || '9222';
let hlsFile = process.env.HLS || '/tmp/hlsprobe/hls-1.5.20.min.js';
let url = process.env.STREAM || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
let waitMs = +(process.env.WAIT_MS || 22000);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--port') port = argv[++i];
  else if (argv[i] === '--hls') hlsFile = argv[++i];
  else if (argv[i] === '--url') url = argv[++i];
}

const hlsSrc = readFileSync(hlsFile, 'utf8');

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url)) || targets.find(t => t.type === 'page');
if (!page) { console.error('找不到页面目标'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) => {
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
};
const evalJS = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result && r.result.exceptionDetails) {
    return { __err: r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails) };
  }
  return r.result?.result?.value;
};

// 默认在【干净空页】里测。
// 在央视频页面上测会被三件事污染：站点自己的播放器在跑、我们的注入 CSS
// 会把新节点 display:none（媒体元素一隐藏就被挂起）、站点的定时器抢帧。
// 真实部署里自定义源也是独立页面，所以在空页测才等价。
const BLANK = process.env.BLANK !== '0';
if (BLANK) {
  await send('Page.enable', {});
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise(r => setTimeout(r, 2500));
}

console.log(`目标: ${page.url.slice(0, 60)}${BLANK ? '  → 已切到 about:blank' : ''}`);
console.log(`hls.js: ${hlsFile}  (${(hlsSrc.length / 1024).toFixed(0)} KB)`);
console.log(`测试流: ${url}\n`);

// --- 1. 环境自述 ---
const env = await evalJS(`JSON.stringify({
  ua: navigator.userAgent,
  mse: typeof window.MediaSource,
  mseSupported: !!(window.MediaSource && window.MediaSource.isTypeSupported &&
      window.MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')),
  wasm: typeof window.WebAssembly,
  fetch: typeof window.fetch,
  promise: typeof window.Promise,
})`);
console.log('页面环境:', env);

// --- 2. 注入 hls.js 源码 ---
const cfg = await evalJS(`(function(){
  try {
    ${hlsSrc}
    window.__probeHls = (typeof Hls !== 'undefined') ? Hls : null;
    if (!window.__probeHls) return JSON.stringify({ok:false, why:'Hls 未定义（脚本解析失败？）'});
    return JSON.stringify({
      ok:true,
      version: window.__probeHls.version,
      events: Object.keys(window.__probeHls.Events||{}).length,
    });
  } catch (e) { return JSON.stringify({ok:false, why:String(e)}); }
})()`);
console.log('hls.js 注入:', cfg);
if (!cfg || JSON.parse(cfg).ok !== true) { ws.close(); process.exit(1); }

// --- 3. 起播 ---
await evalJS(`(function(){
  var v = document.createElement('video');
  v.id = '__probeVideo'; v.muted = true; v.playsInline = true;
  v.setAttribute('playsinline','');
  v.style.cssText = 'position:fixed !important;display:block !important;left:0;top:0;width:320px;height:180px;z-index:99999;background:#000';
  // ⚠️ 必须挂进 #app。注入 CSS 的清场规则是
  //    body > *:not(#app):not(#ysp-toast){display:none !important}
  //    挂 body 会被隐藏，而 display:none 的媒体元素会被浏览器挂起 ——
  //    表现极像「hls.js 坏了」：readyState=4、尺寸都对，但 currentTime 永远 0。
  var host = document.querySelector('#app') || document.body;
  host.appendChild(v);
  window.__probeLog = [];
  window.__probeResult = {readyState:0, videoWidth:0, errors:[], frags:0, level:null};
  var Hls = window.__probeHls;
  var h = new Hls({debug:false, enableWorker:false, lowLatencyMode:false, manifestLoadingTimeOut:12000});
  window.__probeHlsInst = h;
  h.on(Hls.Events.MEDIA_ATTACHED, function(){ window.__probeLog.push('MEDIA_ATTACHED'); });
  h.on(Hls.Events.MANIFEST_PARSED, function(_,d){
    window.__probeLog.push('MANIFEST_PARSED levels=' + (d.levels||[]).length);
    window.__probeResult.level = (d.levels||[]).length;
    try { v.play(); } catch(e) {}
  });
  h.on(Hls.Events.FRAG_LOADED, function(){ window.__probeResult.frags++; });
  h.on(Hls.Events.LEVEL_LOADED, function(){ window.__probeLog.push('LEVEL_LOADED'); });
  h.on(Hls.Events.ERROR, function(_,d){
    window.__probeResult.errors.push(d.type + '/' + d.details + (d.fatal?'(fatal)':''));
  });
  h.attachMedia(v);
  h.loadSource(${JSON.stringify(url)});
  return 'started';
})()`);

// --- 4. 轮询 ---
const t0 = Date.now();
let last = '';
let best = { w: 0, t: 0 };
while (Date.now() - t0 < waitMs) {
  await new Promise(r => setTimeout(r, 1500));
  const s = await evalJS(`(function(){
    var v = document.getElementById('__probeVideo');
    if (!v) return JSON.stringify({gone:true});
    var buf = 0;
    try { for (var i=0;i<v.buffered.length;i++) buf += v.buffered.end(i)-v.buffered.start(i); } catch(e){}
    return JSON.stringify({
      rs: v.readyState, w: v.videoWidth, h: v.videoHeight,
      t: +(v.currentTime||0).toFixed(2), buf: +buf.toFixed(2), paused: v.paused,
      err: (window.__probeResult||{}).errors.slice(-3),
      frags: (window.__probeResult||{}).frags,
      level: (window.__probeResult||{}).level,
    });
  })()`);
  const el = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  if (s !== last) { console.log(`  [${el}s] ${s}`); last = s; }
  else { console.log(`  [${el}s] (同上)`); }
  try {
    const o = JSON.parse(s);
    if (o.w > best.w) best.w = o.w;
    if (o.t > best.t) best.t = o.t;
    if (o.w > 0 && o.t > 2) { console.log('\n✅ hls.js 起播成功'); break; }
  } catch {}
}

const fin = await evalJS(`(function(){
  var v = document.getElementById('__probeVideo');
  var o = { w: v?v.videoWidth:0, t: v?+(v.currentTime||0).toFixed(2):0,
            err: (window.__probeResult||{}).errors||[] };
  if (window.__probeHlsInst) { try { window.__probeHlsInst.destroy(); } catch(e){} }
  if (v) v.remove();
  return JSON.stringify(o);
})()`);
console.log('\n最终:', fin);
const o = JSON.parse(fin);
const ok = best.w > 0 && best.t > 1;
console.log(ok
  ? `结论：路 A（hls.js）在该内核可用  —— 最高 ${best.w}px 宽 / 已播 ${best.t}s`
  : `结论：路 A 在该内核不可用  —— 最高 ${best.w}px 宽 / 已播 ${best.t}s`);
ws.close();
process.exit(ok ? 0 : 1);
