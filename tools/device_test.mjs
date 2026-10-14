#!/usr/bin/env node
/* ============================================================
   设备端（模拟器）行为验证 —— 通过 WebView 远程调试直读 __yspTV 内部状态

   为什么不用截图判定：模拟器截图分辨率下，红色高亮行是哪一行根本读不出来。
   所以这里走 CDP：adb 打真键 → WebView 内 Runtime.evaluate 读真实状态。

   前置：
     adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/* 包名从 build.gradle 的 namespace 读，不写死 —— 改包名时测试脚本不会失效。
   ⚠️ 注意读的是 namespace 不是 AndroidManifest 的 package：
   现代 AGP 把 package 从 manifest 挪到了 namespace，manifest 里那个属性不存在。 */
const PKG = (readFileSync(path.join(ROOT, 'yangshipin-tv/app/build.gradle'), 'utf8')
  .match(/namespace\s+['"]([^'"]+)['"]/) || [])[1] || '';
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const CDP = 'http://127.0.0.1:9222';
const SHOTS = path.join(ROOT, 'tools', 'shots');
const DELAY = 450;                 // 一次按键到状态可读
const TAB_SETTLE = 3200;           // switchTab 内部 settle 最晚 2600ms
const HIDE_MS = 5000;              // 面板自动隐藏

// ⚠️ 必须在多设备在线时也能跑：本机同时挂着 TV(5554)/手机(5556)/API21(5558)，
//    裸 `adb` 会直接报 "more than one device/emulator" 而整个套件起不来。
//    以前只在单设备下跑过，所以这个坑一直没暴露。
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';

mkdirSync(SHOTS, { recursive: true });

/* ---------- adb ---------- */
function adb(...a) {
  return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();
}
function shot(name) {
  const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 });
  const p = path.join(SHOTS, name + '.png');
  writeFileSync(p, buf);
  return p;
}
async function key(code, label) {
  adb('shell', 'input', 'keyevent', String(code));
  await sleep(DELAY);
}

/* ---------- 断言 ---------- */
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
  return ok;
}

/* ---------- CDP ---------- */
// ⚠️ 要重试：这个脚本【不自建环境】—— App 和端口转发靠 `tools/tv-emu.sh debug` 先备好。
//    如果上一件事（比如自定义源那套测试）留下了一个指向旧 pid 的转发，
//    fetch 会「连得上但不回包」，undici 默认要等 5 分钟才超时，整轮就这么白跑掉。
//    与其干等，不如 20 次 × 500ms 快速失败，并把排查方向打出来。
let targets = null, lastErr = null;
for (let i = 0; i < 20; i++) {
  try {
    const r = await fetch(CDP + '/json');
    if (r.ok) { targets = await r.json(); break; }
    lastErr = 'HTTP ' + r.status;
  } catch (e) { lastErr = String(e && e.cause && e.cause.code || e.message || e); }
  await sleep(500);
}
if (!targets) {
  console.error(`连不上 WebView 调试端口 ${CDP}（试了 20 次）：${lastErr}`);
  console.error('先跑 `bash tools/tv-emu.sh debug` 起 App + 建转发；');
  console.error('或检查 `adb forward --list` 里的 pid 与 `adb shell pidof com.ysptv.player` 是否一致。');
  process.exit(1);
}
const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
if (!page) {
  // ⚠️ 空数组要单独说清楚。它和「连不上」是两回事，但现象很像：
  //    9222 上有东西在回话（多半是指向**已经死掉的 pid** 的旧转发），
  //    于是 fetch 成功、页面列表却是空的 —— 报错只有一句「找不到页面目标：[]」，
  //    看不出该去跑 tv-emu.sh。实测踩过：上一件事（自定义源那套）留下旧转发，
  //    这一轮就这么白跑了，而且因为 exit(1) 在前面，连汇总行都不会打印。
  if (targets.length === 0) {
    console.error('调试端口在回话，但页面列表是空的 —— 通常是指向了旧 pid 的转发。');
    console.error(`  已转发：${adb('forward', '--list').replace(/\n/g, ' | ') || '（无）'}`);
    console.error(`  当前 pid：${(() => { try { return adb('shell', 'pidof', 'com.ysptv.player') || '（App 没在跑）'; } catch { return '(取不到)'; } })()}`);
    console.error('本脚本【不自建环境】，请先跑 `bash tools/tv-emu.sh debug`。');
    process.exit(1);
  }
  console.error('找不到页面目标：', JSON.stringify(targets, null, 2));
  process.exit(1);
}
console.log('目标页面:', page.title, '\n  url:', page.url, '\n');

let ws;
for (let i = 0; i < 10; i++) {
  ws = new WebSocket(page.webSocketDebuggerUrl);
  try { await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); lastErr = null; break; }
  catch (e) { lastErr = String(e && e.message || e); await sleep(500); }
}
if (lastErr) { console.error('WebSocket 连不上：' + lastErr); process.exit(1); }
let seq = 0;
const pending = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.error) throw new Error('CDP error: ' + JSON.stringify(r.error));
  const res = r.result || {};
  if (res.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(res.exceptionDetails));
  return res.result ? res.result.value : undefined;
}

/* ---------- 状态读取 ---------- */
const STATE = `(function(){
  var T = window.__yspTV;
  if (!T) return JSON.stringify({ ready: false });
  var r  = document.querySelector('.tv-main-con-r');
  var b  = r ? r.getBoundingClientRect() : null;
  var rt = document.querySelector('.tv-main-con');
  var cur= document.querySelector('.tv-main-con-r-list-left > div.ysp-focus');
  var tz = document.getElementById('ysp-toast');
  var v  = document.querySelector('.tv-main-con-l-vid video');
  var tabs = [].slice.call(document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img'))
             .map(function(t){ var i=t.querySelector('img'); return i?(i.getAttribute('src')||''):''; });
  return JSON.stringify({
    ready: true,
    open: T.isPanelOpen(),
    idx: T.index(),
    count: T.count(),
    tab: T.currentTab(),
    play: T.playing(),
    labels: T.labels(),
    panelLeft: b ? Math.round(b.left) : null,
    panelW: b ? Math.round(b.width) : null,
    panelOnScreen: b ? (b.left > -b.width + 2 && b.right > 2) : null,
    rootOpen: rt ? rt.classList.contains('ysp-panel-open') : null,
    focus: cur ? (cur.innerText || '').trim() : null,
    toast: tz ? { text: (tz.textContent || '').trim(), show: tz.classList.contains('show') } : null,
    tabSrcs: tabs,
    vw: v ? Math.round(v.clientWidth) : null,
    vh: v ? Math.round(v.clientHeight) : null,
    playing: v ? (!v.paused && v.readyState > 2) : false
  });
})()`;
async function S() {
  const raw = await ev(STATE);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
function brief(s) {
  return `open=${s.open} idx=${s.idx} play=${s.play} tab=${s.tab} focus=${JSON.stringify(s.focus)} panelLeft=${s.panelLeft}/${s.panelW}`;
}

/* ---------- 复位 ---------- */
async function reset() {
  await ev(`(function(){ var T=window.__yspTV; if(!T) return 0; T.closePanel(); return 1; })()`);
  const st = await S();
  if (st.tab !== 0) {
    await ev(`window.__yspTV.switchTab(0)`);
    await sleep(TAB_SETTLE);
  }
  await sleep(300);
}

/* ============================================================
   开跑
   ============================================================ */
// ⚠️ 不能只读一次就判「注入失败」。
//    tv-emu.sh debug 只等到 devtools 通道能连上（那时页面往往**还在加载**），
//    而注入是 MainActivity 在 onPageFinished 之后才做的，之后还有 boot() 与
//    [1500,3000,5000,8000]ms 的四次重试去等频道容器出现。
//    单次读 + 立刻 exit(1) 会把「页面还没加载完」报成「注入失败」——
//    看着像产品坏了，其实只是抢跑。实测就踩到过：整条链 5 秒跑完、
//    打印「⚠️ 页面内没有 __yspTV」，而同一台设备上多等几秒再跑就是 80/80。
//    所以这里等到「注入完成 **且** 频道列表已经有行」再开始，超时才算真失败。
let s0 = null;
for (let i = 0; i < 60; i++) {
  s0 = await S();
  if (s0.ready && s0.count > 0) break;
  await sleep(1000);
}
if (!s0.ready) {
  console.error('⚠️ 等了 60 秒页面里仍然没有 __yspTV —— 注入真的失败了（不是抢跑）。');
  console.error('   先确认页面本身起来了：');
  try { console.error('   url=', await ev('location.href')); } catch {}
  try { console.error('   页面里有没有频道容器：', await ev(`!!document.querySelector('.tv-main-con-r')`)); } catch {}
  process.exit(1);
}
if (!s0.count) {
  console.error('⚠️ __yspTV 在，但 60 秒内一条频道都没读出来（count=0）。');
  console.error('   多半是央视频改版 / 没网 / 选了「本机内核不支持」说明页。');
  try { console.error('   url=', await ev('location.href')); } catch {}
  process.exit(1);
}
console.log('基线状态:', brief(s0));
console.log(`  频道总数=${s0.count}  视频区=${s0.vw}x${s0.vh}  播放中=${s0.playing}`);
console.log(`  tab 图标: ${JSON.stringify(s0.tabSrcs)}`);
console.log('');
await reset();
await ensureVideoPlaying('基线');
s0 = await S();

/* --- 1. 默认态：面板必须收起 --- */
console.log('【1】默认态');
check('面板默认收起', s0.open === false, `open=${s0.open}`);
check('面板在屏幕外（左滑出）', s0.panelOnScreen === false, `panelLeft=${s0.panelLeft} w=${s0.panelW}`);
check('视频正在播放', s0.playing === true, `readyState/video=${s0.vw}x${s0.vh}`);
check('频道列表可读', s0.count > 30, `count=${s0.count}`);
shot('t1_default');

/* --- 2. 收起态上下键 = 直接换台 --- */
console.log('\n【2】面板收起时 上/下 直接换台');
const before2 = await S();
await key(20, 'DPAD_DOWN');
const after2 = await S();
check('下键后播放台前进 1',
  after2.play === clamp(before2.play + 1, after2.count), `play ${before2.play} → ${after2.play}`);
check('下键后仍然保持收起', after2.open === false, `open=${after2.open}`);
check('换台气泡显示了新台名', after2.toast && after2.toast.show && after2.toast.text.length > 0,
  `toast=${JSON.stringify(after2.toast)}`);
shot('t2_down');

await sleep(1800);
await key(19, 'DPAD_UP');
const after2b = await S();
check('上键后播放台后退 1',
  after2b.play === clamp(after2.play - 1, after2b.count), `play ${after2.play} → ${after2b.play}`);

/* --- 3. 确认键弹出面板，光标落在正在播放的那一路 --- */
console.log('\n【3】确认键弹出面板');
await ensurePanelClosed();            // 面板得先是收起的，这一下确认键才是「弹出」
const before3 = await S();
await key(23, 'DPAD_CENTER');
const p3 = await S();
check('确认键后面板展开', p3.open === true, `open=${p3.open}`);
check('root 带上了 ysp-panel-open', p3.rootOpen === true);
check('面板贴到左边缘（left≈0）', Math.abs(p3.panelLeft) <= 2, `panelLeft=${p3.panelLeft}`);
check('面板宽度约 20vw', p3.panelW > 100 && p3.panelW < p3.vw * 0.45, `panelW=${p3.panelW} / vw=${p3.vw}`);
check('面板已滑入屏幕内', p3.panelOnScreen === true);
check('光标落在正在播放的那一路',
  before3.play >= 0 ? p3.idx === before3.play : p3.idx === 0,
  `idx=${p3.idx} play=${before3.play} label=${JSON.stringify(p3.focus)}`);
shot('t3_panel_open');

/* --- 4. 面板内上下键 = 只移光标，不换台 --- */
console.log('\n【4】面板展开时 上/下 只移光标');
await ensurePanelOpen();              // 上一张截图可能已经把面板耗到自动隐藏了
const before4 = await S();
await key(20, 'DPAD_DOWN');
const a4 = await S();
check('光标下移 1', a4.idx === clamp(before4.idx + 1, a4.count), `idx ${before4.idx} → ${a4.idx}`);
check('播放台没有跟着变', a4.play === before4.play, `play ${before4.play} → ${a4.play}`);
check('高亮行跟着光标走', a4.focus === a4.labels[a4.idx],
  `focus=${JSON.stringify(a4.focus)} labels[${a4.idx}]=${JSON.stringify(a4.labels[a4.idx])}`);
await key(20, 'DPAD_DOWN');
await key(20, 'DPAD_DOWN');
const a4b = await S();
check('连按三次下光标下移 3 格', a4b.idx === clamp(before4.idx + 3, a4b.count),
  `idx=${a4b.idx}`);
check('仍然没换台', a4b.play === before4.play, `play=${a4b.play}`);
check('面板仍然展开', a4b.open === true);
shot('t4_cursor_moved');

/* --- 5. 面板内确认 = 选中该台并收起 --- */
console.log('\n【5】面板内按确认 = 选中并收起');
// ⚠️ 必须在读 before5 *之前* 把面板打开：从收起态被确认键弹开时，光标会被
//    复位到「正在播放的那一路」，所以 idx 一定要在 ensure 之后再读。
await ensurePanelOpen();
const before5 = await S();
const want5 = before5.idx;
const wantName = before5.labels[want5];
await key(23, 'DPAD_CENTER');
await sleep(1400);                       // 等站点把 tvSelect 挪过去
const a5 = await S();
check('该台成为正在播放', a5.play === want5, `期望 play=${want5} 实际=${a5.play} (${wantName})`);
check('面板已收起', a5.open === false, `open=${a5.open}`);
check('面板滑出屏幕', a5.panelOnScreen === false, `panelLeft=${a5.panelLeft}`);
check('气泡提示选中的台名', a5.toast && normText(a5.toast.text) === normText(wantName),
  // ⚠️ 比的是「折叠空白之后」的串：名字里带换行的是站点自己的排版
  //    （例如「CCTV央视台球频道\n(VIP)」），面板把它当一行显示成空格。
  //    直接 === 比会因为这个换行稳定报红，而用户看到的台名是对的。
  `toast=${JSON.stringify(a5.toast && a5.toast.text)} 期望=${JSON.stringify(wantName)}`);
shot('t5_selected');

/* --- 6. 左右键切 tab：CCTV ↔ 卫视 --- */
console.log('\n【6】左右键切换 CCTV / 卫视');
await reset();
await key(23, 'DPAD_CENTER');
await sleep(300);
const t6a = await S();
check('起始在 tab 0（央视频道）', t6a.tab === 0, `tab=${t6a.tab}`);
check('tab0 里有 CCTV 频道', t6a.labels.some(l => /CCTV/.test(l)), `前3=${JSON.stringify(t6a.labels.slice(0, 3))}`);

await key(22, 'DPAD_RIGHT');
await sleep(TAB_SETTLE);
const t6b = await S();
check('右键后切到 tab 1（卫视）', t6b.tab === 1, `tab=${t6b.tab} tabSrcs=${JSON.stringify(t6b.tabSrcs)}`);
check('tab1 里没有 CCTV 混入', !t6b.labels.some(l => /CCTV/.test(l)),
  `前6=${JSON.stringify(t6b.labels.slice(0, 6))}`);
check('tab1 里确实有卫视台', t6b.labels.some(l => /卫视/.test(l)), `count=${t6b.count}`);
check('切 tab 后面板仍在（未误关）', t6b.open === true, `open=${t6b.open}`);
shot('t6_tab_satellite');

await key(21, 'DPAD_LEFT');
await sleep(TAB_SETTLE);
const t6c = await S();
check('左键切回 tab 0（央视）', t6c.tab === 0, `tab=${t6c.tab}`);
check('tab0 又出现 CCTV', t6c.labels.some(l => /CCTV/.test(l)), `count=${t6c.count}`);

/* --- 7. 自动隐藏 --- */
console.log('\n【7】面板 5 秒无操作自动隐藏');
await reset();
await key(23, 'DPAD_CENTER');
const t7a = await S();
check('面板已展开（准备计时）', t7a.open === true);
console.log(`     等待 2.5s …`);
await sleep(2500);
const t7b = await S();
check('2.5s 时面板还在', t7b.open === true, `open=${t7b.open}`);
console.log(`     再等 3.6s（累计 6.1s）…`);
await sleep(3600);
// 自动隐藏的阈值是 5s，实测等待 6.1s 只留 1.1s 余量 —— 模拟器一忙就会抖成假失败
// （曾经在并发跑别的脚本时红过一次）。所以这里轮询到 9s：
// 仍然证明「会自动隐藏」，但不再把负载抖动算成缺陷。
// 上面「2.5s 时面板还在」那一半继续防「过早隐藏」。
let t7c = await S();
for (let i = 0; i < 15 && t7c.open === true; i++) {
  await sleep(200);
  t7c = await S();
}
check('超时后面板自动隐藏', t7c.open === false, `open=${t7c.open}`);
check('隐藏后仍保持原台播放', t7c.play === t7b.play, `play ${t7b.play} → ${t7c.play}`);
shot('t7_autohidden');

/* --- 8. 隐藏后上下键恢复「直接换台」语义 --- */
console.log('\n【8】隐藏后上下键回到换台语义');
const before8 = await S();
await key(20, 'DPAD_DOWN');
const a8 = await S();
check('隐藏态下键直接换台', a8.play === clamp(before8.play + 1, a8.count),
  `play ${before8.play} → ${a8.play}`);
check('并且没有把面板弹出来', a8.open === false, `open=${a8.open}`);

/* --- 9. 视频始终全屏、且不被面板挤压 --- */
console.log('\n【9】视频区占满整屏，面板弹出时不挤压视频');
const GEO = `JSON.stringify((function(){
  var v = document.querySelector('.tv-main-con-l-vid video');
  var l = document.querySelector('.tv-main-con-l');
  var rr = l ? l.getBoundingClientRect() : null;
  var vv = v ? v.getBoundingClientRect() : null;
  return {
    iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio,
    box: rr ? [Math.round(rr.left), Math.round(rr.top), Math.round(rr.width), Math.round(rr.height)] : null,
    vid: vv ? [Math.round(vv.left), Math.round(vv.top), Math.round(vv.width), Math.round(vv.height)] : null,
    fit: v ? getComputedStyle(v).objectFit : null,
    natural: v ? [v.videoWidth, v.videoHeight] : null
  };
})())`;
async function geo() { return JSON.parse(await ev(GEO)); }

/* 换台瞬间 video 元素会被重置，videoWidth 短暂为 0 —— 轮询等元数据解码完 */
async function waitVideoReady(ms = 25000) {
  const t0 = Date.now();
  for (;;) {
    const r = JSON.parse(await ev(`(function(){
      var v = document.querySelector('.tv-main-con-l-vid video');
      return JSON.stringify(v ? [v.videoWidth, v.videoHeight, v.readyState, v.paused] : null);
    })()`));
    if (r && r[0] > 0 && r[2] >= 2 && r[3] === false) return { ok: true, waited: Date.now() - t0, v: r };
    if (Date.now() - t0 > ms) return { ok: false, waited: Date.now() - t0, v: r };
    await sleep(400);
  }
}

/**
 * 等起播，并且**把结果用起来**。
 *
 * ⚠️ 以前两个调用点都是 `await waitVideoReady();` —— 返回值直接丢掉，
 *    于是「央视频这条直播流起播慢 / 当场失败」和「代码真的坏了」在报告里长得一模一样
 *    （都只是后面那条 `视频正在播放` 变红），排查时只能靠猜。
 *    现在：超时了先打印实际状态，再 closePanel + 切回 CCTV 重选一次频道重试；
 *    无论如何都把等了多久、videoWidth/readyState 打出来，失败时能一眼归因。
 *    （这条直播流的起播时间受网络和机器负载影响很大，12 秒在忙的时候不够用。）
 */
async function ensureVideoPlaying(label) {
  let w = await waitVideoReady();
  if (!w.ok) {
    console.log(`  ⚠️ [${label}] 等起播超时 ${w.waited}ms（readyState=${w.v ? w.v[2] : 'n/a'}）`
      + ' —— 重选一次频道再等');
    await reset();
    w = await waitVideoReady();
  }
  console.log(`  · [${label}] 起播${w.ok ? '就绪' : '仍失败'}：等了 ${w.waited}ms，`
    + `video=${w.v ? `${w.v[0]}x${w.v[1]} readyState=${w.v[2]} paused=${w.v[3]}` : 'null'}`);
  return w;
}

/**
 * 展示类字符串的比较：把换行/连续空白折叠掉再比（台名里带换行是站点自己的排版，
 * 例如「CCTV央视台球频道\n(VIP)」）。
 * ⚠️ 故意写成 function 而不是 const：它第一次被用到的地方在文件很前面，
 *    而 const 有 TDZ —— 踩过一次，`Cannot access 'normText' before initialization`，
 *    整个套件跑到【5】当场崩掉，前面的结果全白跑。
 */
function normText(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

/**
 * 把「面板是开是关」钉死，再往下断言。
 *
 * ⚠️ 面板 5 秒无操作就自动隐藏，而这个套件里到处是「截图 + 好几次 CDP 取值」——
 *    慢的时候一次 screencap 就能吃掉好几秒（实测过一次 14.7s）。
 *    于是会出现这种假红：
 *      【4】移完光标、截完图 → 面板已经自己收了 → 【5】按确认键
 *      → 这一下不是「选中并收起」，而是「从收起态弹出面板」
 *      → 于是「该台成为正在播放 / 面板已收起 / 面板滑出屏幕」三条一起红，
 *        看上去像遥控器的确认键坏了。
 *    （同类问题在 custom_source_test.mjs 里已经用 ensurePanelOpen/Closed 治过，
 *      这份套件当时漏了。）
 */
async function ensurePanelOpen() {
  for (let i = 0; i < 3; i++) {
    const s = await S();
    if (s.open === true && s.panelOnScreen === true) return true;
    await key(23, 'DPAD_CENTER');          // 收起态下确认键 = 弹出面板
    await sleep(700);
  }
  const s = await S();
  console.log(`  ⚠️ ensurePanelOpen 没能把面板打开（open=${s.open} left=${s.panelLeft}）`);
  return false;
}
async function ensurePanelClosed() {
  for (let i = 0; i < 3; i++) {
    const s = await S();
    if (s.open === false) return true;
    await key(4, 'BACK');                  // 面板开着时返回键 = 收起（不会触发退出）
    await sleep(700);
  }
  return (await S()).open === false;
}

await reset();
await ensureVideoPlaying('几何');
let g0 = await geo();
const [iw, ih] = [g0.iw, g0.ih];
check('横屏视口（宽 > 高）', iw > ih, `viewport=${iw}x${ih} dpr=${g0.dpr} → 物理 ${Math.round(iw * g0.dpr)}x${Math.round(ih * g0.dpr)}`);
check('播放器容器 = 整个视口', JSON.stringify(g0.box) === JSON.stringify([0, 0, iw, ih]),
  `container=${JSON.stringify(g0.box)} 视口=[0,0,${iw},${ih}]`);
check('video 元素 = 整个播放器容器', JSON.stringify(g0.vid) === JSON.stringify(g0.box),
  `video=${JSON.stringify(g0.vid)}`);
check('object-fit 为 contain（不裁切、不变形）', g0.fit === 'contain', `fit=${g0.fit}`);
check('拿到真实片源尺寸且正在解码播放', g0.natural && g0.natural[0] > 0,
  `natural=${JSON.stringify(g0.natural)}`);

// 面板弹出时，视频区几何必须纹丝不动（面板是浮层，不能挤压舞台）
await key(23, 'DPAD_CENTER');
await sleep(600);
const g1 = await geo();
check('面板弹出后 video 矩形不变（浮层不挤压）', JSON.stringify(g1.vid) === JSON.stringify(g0.vid),
  `收起时=${JSON.stringify(g0.vid)} 展开时=${JSON.stringify(g1.vid)}`);
check('面板弹出后容器矩形不变', JSON.stringify(g1.box) === JSON.stringify(g0.box),
  `收起时=${JSON.stringify(g0.box)} 展开时=${JSON.stringify(g1.box)}`);
await reset();

/* --- 10. 行对齐：上下边缘都不能留半行 --- */
console.log('\n【10】列表行对齐（上下边缘不留半行）');
const ALIGN = `(function(){
  var l = document.querySelector('.tv-main-con-r-list-left');
  if (!l) return JSON.stringify({ ok:false });
  var lb = l.getBoundingClientRect();
  var cs = getComputedStyle(l);
  var rs = [].slice.call(l.children).filter(function(r){ return r.offsetParent !== null; });
  if (!rs.length) return JSON.stringify({ ok:false });
  var rowH = rs[0].getBoundingClientRect().height;
  var base = l.scrollTop + (rs[0].getBoundingClientRect().top - lb.top);
  // 顶边：找一行，其顶边最贴近列表顶边
  var topGap = 1e9, topLabel = '';
  rs.forEach(function(r){
    var g = r.getBoundingClientRect().top - lb.top;
    if (Math.abs(g) < Math.abs(topGap)) { topGap = g; topLabel = (r.innerText||'').trim(); }
  });
  // 底边：找一行，其底边最贴近列表底边
  var bb = lb.top + lb.height, botGap = 1e9, botLabel = '';
  rs.forEach(function(r){
    var g = r.getBoundingClientRect().bottom - bb;
    if (Math.abs(g) < Math.abs(botGap)) { botGap = g; botLabel = (r.innerText||'').trim(); }
  });
  var per = l.clientHeight / rowH;
  var off = (l.scrollTop - base) % rowH;
  return JSON.stringify({
    ok: true,
    pad: (parseFloat(cs.paddingTop)||0) + (parseFloat(cs.paddingBottom)||0),
    rowH: +rowH.toFixed(4),
    viewH: l.clientHeight,
    perView: +per.toFixed(4),
    perViewInt: Math.abs(per - Math.round(per)) < 0.02,
    scrollTop: +l.scrollTop.toFixed(3),
    base: +base.toFixed(4),
    snapOff: +Math.min(Math.abs(off), rowH - Math.abs(off)).toFixed(3),
    topGap: +topGap.toFixed(3), topLabel: topLabel,
    botGap: +botGap.toFixed(3), botLabel: botLabel
  });
})()`;
async function align() {
  const raw = await ev(ALIGN);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function checkAlign(tag, a) {
  check(`${tag} · 列表无内边距`, a.pad === 0, `pad=${a.pad}px`);
  check(`${tag} · 一屏正好整数行`, a.perViewInt, `clientH=${a.viewH} ÷ rowH=${a.rowH} = ${a.perView}`);
  check(`${tag} · 滚动位置对齐到整行`, a.snapOff < 0.8, `scrollTop=${a.scrollTop} rowH=${a.rowH} 偏差=${a.snapOff}px`);
  check(`${tag} · 顶边没有半行`, Math.abs(a.topGap) < 1.2, `顶行「${a.topLabel}」边缘偏差=${a.topGap}px`);
  check(`${tag} · 底边没有半行`, Math.abs(a.botGap) < 1.2, `底行「${a.botLabel}」边缘偏差=${a.botGap}px`);
}

await reset();
await key(23, 'DPAD_CENTER');
await sleep(500);
await checkAlign('顶部', await align());
shot('t10a_align_top');

for (let k = 0; k < 14; k++) await key(20);       // 滚到中段
await sleep(500);
await checkAlign('中段', await align());
shot('t10b_align_mid');

for (let k = 0; k < 30; k++) await key(20);       // 滚到底
await sleep(500);
await checkAlign('底部', await align());
shot('t10c_align_bottom');

await reset();
await key(23, 'DPAD_CENTER');
await sleep(400);
await key(22);                                    // 换到卫视
await sleep(TAB_SETTLE);
await checkAlign('卫视页', await align());
shot('t10d_align_satellite');
await reset();

/* --- 11. 返回键：面板展开时先收起面板，而不是进入退出倒计时 --- */
console.log('\n【11】返回键行为');
async function focusApp() {
  const out = adb('shell', 'dumpsys', 'activity', 'activities');
  const line = out.split('\n')
    .filter(l => /topResumedActivity|ResumedActivity/.test(l))
    .join(' || ').trim();
  return new RegExp(PKG.replace(/\./g, '\\.')).test(line) ? line : '';
}
check('应用仍在前台（初始）', !!(await focusApp()), `前台 = ${await focusApp()}`);
await key(23, 'DPAD_CENTER');
await sleep(400);
const b1 = await S();
check('面板已展开（准备测返回键）', b1.open === true, `open=${b1.open}`);

adb('shell', 'input', 'keyevent', '4');          // BACK
await sleep(900);
const b2 = await S();
check('返回键把面板收起来了', b2.open === false, `open=${b2.open}`);
check('返回键没有退出应用（面板开着时只收起）',
  new RegExp(PKG.replace(/\./g, '\\.')).test(await focusApp()), `前台 = ${await focusApp()}`);
check('面板收起后播放台未变', b2.play === b1.play, `play ${b1.play} → ${b2.play}`);

// 面板已收起，此时返回键才该进入「再按一次退出」逻辑（不真退出，只验证提示）
adb('shell', 'input', 'keyevent', '4');
await sleep(500);
check('收起态下返回键不会立即退出',
  new RegExp(PKG.replace(/\./g, '\\.')).test(await focusApp()), `前台 = ${await focusApp()}`);
await sleep(2400);                                // 让 2 秒退出窗口过期，避免误退出
shot('t11_back_close');

/* --- 12. 排版可读性（电视上最关键的一项） --- */
console.log('\n【12】排版可读性');
const TYPO = `(function(){
  var l = document.querySelector('.tv-main-con-r-list-left');
  if (!l) return JSON.stringify({ ok:false });
  var rs = [].slice.call(l.children).filter(function(r){ return r.offsetParent !== null; });
  if (!rs.length) return JSON.stringify({ ok:false });
  var rowH = rs[0].getBoundingClientRect().height;
  var sp = rs[0].querySelector('span');
  var cs = sp ? getComputedStyle(sp) : null;
  var fs = cs ? parseFloat(cs.fontSize) : 0;
  // 短名字不该被 ellipsis 截断
  var short = rs.filter(function(r){ return /^CCTV\\d+$/.test((r.innerText||'').trim()); })[0];
  var ssp = short ? short.querySelector('span') : null;
  var clipped = ssp ? (ssp.scrollWidth > ssp.clientWidth + 1) : null;
  // 两个 tab logo 必须等高
  var imgs = [].slice.call(document.querySelectorAll('.tv-main-con-r-tab > .tv-main-con-r-tab-img img'));
  var hs = imgs.map(function(i){ return Math.round(i.getBoundingClientRect().height); });
  var panelW = document.querySelector('.tv-main-con-r').getBoundingClientRect().width;
  return JSON.stringify({
    ok: true,
    rowH: +rowH.toFixed(2),
    fontCss: +fs.toFixed(2),
    dpr: window.devicePixelRatio,
    fontPhysical: +(fs * window.devicePixelRatio).toFixed(1),
    ratio: +(fs / rowH).toFixed(3),
    panelW: Math.round(panelW),
    innerW: window.innerWidth,
    logoHeights: hs,
    shortNameClipped: clipped,
    shortName: short ? (short.innerText||'').trim() : null
  });
})()`;
await reset();
await key(23, 'DPAD_CENTER');
await sleep(600);
const ty = JSON.parse(await ev(TYPO));
console.log(`  行高=${ty.rowH}css  字号=${ty.fontCss}css = ${ty.fontPhysical}物理px  dpr=${ty.dpr}  字/行=${ty.ratio}`);
check('字号占行高 35%~55%（不空不挤）', ty.ratio >= 0.35 && ty.ratio <= 0.55, `ratio=${ty.ratio}`);
check('物理字高 ≥ 30px（1080p 电视可读）', ty.fontPhysical >= 30, `${ty.fontPhysical}px`);
check('短台名未被截断', ty.shortNameClipped === false, `「${ty.shortName}」clipped=${ty.shortNameClipped}`);
check('两个 tab logo 等高', ty.logoHeights.length === 2 && Math.abs(ty.logoHeights[0] - ty.logoHeights[1]) <= 2,
  `CCTV=${ty.logoHeights[0]}px  卫视=${ty.logoHeights[1]}px`);
check('面板宽度占屏 15%~32%', ty.panelW / ty.innerW >= 0.15 && ty.panelW / ty.innerW <= 0.32,
  `面板=${ty.panelW}px / 视口=${ty.innerW}px = ${(ty.panelW / ty.innerW).toFixed(3)}`);
shot('t12_typography');
await reset();

/* ---------- 【13】自动横屏 / 全屏沉浸 ---------- */
console.log('\n【13】自动横屏（电视端硬锁 + 全屏沉浸）');
{
  // 13.1 物理屏幕方向：直接读 PNG 的 IHDR 宽高，比解析 dumpsys 稳
  const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 });
  const pw = buf.readUInt32BE(16), ph = buf.readUInt32BE(20);
  check('物理屏幕为横向（不会出现竖屏帧）', pw > ph, `${pw}x${ph}`);

  const cfg = adb('shell', 'dumpsys', 'window', 'windows');

  // 13.2 窗口配置是 land，不是 port
  const cm = cfg.match(/sw\d+dp w\d+dp h\d+dp \d+dpi [a-z ]*/);
  check('窗口配置为 land（未回落 port）', !!cm && /\bland\b/.test(cm[0]),
    cm ? cm[0].trim() : '(未读到)');

  // 13.3 走的确实是「电视」分支：日志里应有硬锁声明
  const logs = adb('shell', 'logcat', '-d', '-s', 'YSPTV:I');
  const line = (logs.match(/横屏策略: [^\n]*/) || [])[0];
  check('识别为电视并硬锁 LANDSCAPE', /电视→LANDSCAPE/.test(logs), line || '(未读到策略日志)');

  // 13.4 窗口铺满物理屏幕 = 状态栏/导航栏确实隐藏了
  //      （hideSystemUi 从废弃的 setSystemUiVisibility 换成了 WindowInsetsController，
  //        这条盯住换 API 之后没退化成「栏一直挂着」）
  const size = (adb('shell', 'wm', 'size').match(/Physical size: (\d+)x(\d+)/) || []);
  const bd = cfg.match(/mBounds=Rect\(0, 0 - (\d+), (\d+)\)/);
  check('窗口铺满物理屏幕（系统栏已隐藏）',
    !!bd && !!size[1] && +bd[1] === +size[1], 
    bd ? `窗口=${bd[1]}x${bd[2]}  物理=${size[1]}x${size[2]}` : '(未读到窗口边界)');
}

/* ---------- 【14】面板顶部常驻的「自定义源」入口（1.5.1） ----------
   为什么必须有这一组用例：
     「自定义源」一直是好的（am start 能跑、能播），但用户说「看不到」。
     根因是 Google TV 桌面会把同一包名的多个 LEANBACK_LAUNCHER 入口聚合成一张卡片，
     桌面那张「自定义源」卡片永远不出现，只剩蓝键 / 长按菜单键两个隐藏操作。
     所以 1.5.1 在选台面板顶部加了一行常驻入口。这一组盯的是三件事：
       ① 入口真的挂出来了、看得见、且在频道列表之外（不能污染 rows()/count）
       ② 遥控器走得到（第 0 台再按一次上键）
       ③ 在入口上按确认真的打开自定义源页
*/
console.log('\n【14】面板顶部常驻的「自定义源」入口');
const ENTRY = `(function(){
  var T = window.__yspTV; if (!T) return JSON.stringify({ ready:false });
  var e   = document.getElementById('ysp-custom-entry');
  var l   = document.querySelector('.tv-main-con-r-list-left');
  var tab = document.querySelector('.tv-main-con-r-tab');
  var b  = e   ? e.getBoundingClientRect()   : null;
  var lb = l   ? l.getBoundingClientRect()   : null;
  var tb = tab ? tab.getBoundingClientRect() : null;
  return JSON.stringify({
    ready: true,
    wanted: T.entryWanted ? T.entryWanted() : null,
    has: !!e,
    text: e ? (e.textContent||'').trim() : null,
    inList: !!(l && e && l.contains(e)),
    parentIsPanel: !!(e && e.parentNode && String(e.parentNode.className).indexOf('tv-main-con-r') >= 0),
    w: b ? Math.round(b.width) : 0,
    h: b ? Math.round(b.height) : 0,
    top: b ? Math.round(b.top) : null,
    belowTab:  !!(b && tb && b.top >= tb.bottom - 2),
    aboveList: !!(b && lb && b.bottom <= lb.top + 2),
    count: T.count(),
    idx: T.index(),
    onEntry: T.onEntry ? T.onEntry() : null,
    rowFocus: !!document.querySelector('.tv-main-con-r-list-left > div.ysp-focus'),
    entryFocus: !!(e && e.classList.contains('ysp-focus'))
  });
})()`;
const E = async () => JSON.parse(await ev(ENTRY));

await reset();
await ensurePanelOpen();
const e1 = await E();
check('面板顶部挂着「自定义源」入口', e1.has, `text=${JSON.stringify(e1.text)}`);
check('入口不在频道列表里（不会被 rows() 当成第 0 个频道）',
  e1.inList === false && e1.parentIsPanel === true,
  `inList=${e1.inList} parentIsPanel=${e1.parentIsPanel}`);
check('入口有实际可见尺寸（真的看得到）', e1.w > 40 && e1.h >= 20, `${e1.w}x${e1.h}`);
check('入口钉在 tab 之下、频道列表之上', e1.belowTab && e1.aboveList, `top=${e1.top}`);
check('入口没有混进频道条数', e1.count > 30 && e1.count === (await S()).count, `count=${e1.count}`);
shot('t14_entry');

/* 遥控器可达性：大跨度回顶不能误进入口，只有「已在第 0 台再按一次上」才进 */
await ensurePanelOpen();
await ev('__yspTV.move(-99)');
await sleep(250);
const e2 = await E();
check('大跨度回顶 move(-99) 仍落回第 0 行、且不会误进入口',
  e2.idx === 0 && e2.onEntry === false, `idx=${e2.idx} onEntry=${e2.onEntry}`);

await ensurePanelOpen();
await key(19, 'DPAD_UP');
await sleep(350);
const e3 = await E();
check('光标在第 0 台再按一次上键 → 落在「自定义源」入口上',
  e3.onEntry === true && e3.entryFocus === true && e3.rowFocus === false,
  `onEntry=${e3.onEntry} entryFocus=${e3.entryFocus} rowFocus=${e3.rowFocus}`);
shot('t14_entry_focus');
/* ⚠️ 这条看着像废话，其实是最要紧的一条。
    光标停在入口上时，频道行【永远没有焦点】，而观察者的规则是「没焦点就重画」——
    一旦重画本身会写 class（clearFocus 无条件 remove），就会陷入
    paint → 写 class → 观察者 → paint 的无限微任务循环：主线程再也回不到事件循环，
    渲染进程 107% CPU 空转，CDP 的 Runtime.evaluate 永不回包。
    现象和「App 崩了」完全一样，但 logcat 里一个异常都没有 —— 只有「页面还答不答话」
    能把它测出来。所以这里量的是【evaluate 的往返耗时】，不是某个状态值。 */
{
  const t0 = Date.now();
  const alive = await ev('1+1');
  const dt = Date.now() - t0;
  check('光标停在入口上时页面没有卡死（evaluate 秒回）',
    alive === 2 && dt < 3000, `1+1=${alive} 耗时=${dt}ms`);
}

await ensurePanelOpen();
await key(20, 'DPAD_DOWN');
await sleep(350);
const e4 = await E();
check('从入口往下 = 回到第 0 台（入口是列表上方的一个额外位置）',
  e4.onEntry === false && e4.idx === 0, `onEntry=${e4.onEntry} idx=${e4.idx}`);

/* 确认键：真的打开自定义源页（不是只在页面里比划一下） */
await ensurePanelOpen();
const okFocus = await ev('__yspTV.focusEntry()');
check('focusEntry() 能把光标直接放到入口上', okFocus === true, `ret=${okFocus}`);
await key(23, 'DPAD_CENTER');
await sleep(1600);
const fgCustom = await focusApp();
check('在入口上按确认 → 真的打开自定义源 Activity',
  /CustomActivity/.test(fgCustom), `前台=${fgCustom || '(不是我们的)'}`);
shot('t14_custom_opened');
// 回主界面。⚠️ v1.9 起要按【三下】返回，不是两下。
// 分层退的顺序是：键盘 → 源管理浮层 → 选台面板 → 才轮到 Activity 的
// 「连按两次退出」。而 1.9 之后不再有内置示例源，零源时 CustomActivity
// 会**自动打开源管理**（onPageReady → openManage()，把用户直接送到添加流程），
// 于是最外层前面多了一层「关浮层」——两下只够关掉浮层 + 触发第一次退出提示。
for (let i = 0; i < 3; i++) {
  adb('shell', 'input', 'keyevent', '4');
  await sleep(900);
}
check('返回键回到主界面（v1.9：零源自动开着源管理，要三下）',
  /MainActivity/.test(await focusApp()), `前台=${await focusApp()}`);
await sleep(2400);   // 让主界面的「再按一次退出」窗口过期，别把后续用例带崩

/* ---------- 汇总 ---------- */
ws.close();
const pass = results.filter(r => r.ok).length;
console.log('\n' + '='.repeat(62));
console.log(`结果： ${pass}/${results.length} 通过`);
if (pass !== results.length) {
  console.log('\n未通过项：');
  results.filter(r => !r.ok).forEach(r => console.log('  ❌ ' + r.name + '   — ' + r.detail));
}
console.log('截图目录：' + SHOTS);
console.log('='.repeat(62));
process.exit(pass === results.length ? 0 : 2);

function clamp(i, n) { return i < 0 ? 0 : (i >= n ? n - 1 : i); }
