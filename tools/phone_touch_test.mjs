#!/usr/bin/env node
/* ============================================================
   手机端触摸操作验证

   背景：这套界面原本只为电视遥控器设计（上下键换台、确认键弹面板）。
   手机没有方向键，必须补一层触摸手势，否则手机上根本没法换台。
   这份脚本验证那层手势，以及「遥控器路径没被带坏」。

   手势契约：
     面板收起   轻点屏幕    = 确认键  → 弹出左侧选台面板
                上滑 / 下滑 = 上/下键 → 下一台 / 上一台
     面板展开   点频道行    = 确认键  → 选中该台并收起
                点 tab      = 左/右键 → 切 CCTV / 卫视
                点面板外    = 收起
                列表内拖动  = 原生滚动，松手吸附到整行
                面板外上滑  = 收起并换台

   用法：
     node tools/phone_touch_test.mjs
   前置：
     手机模拟器在线（默认 emulator-5556，可用 ANDROID_SERIAL 覆盖）
     已装 debug APK 并建好 CDP 通道：
       adb -s emulator-5556 forward tcp:9223 localabstract:webview_devtools_remote_<pid>
   ⚠️ 全程用物理像素坐标（input tap/swipe 走的就是物理帧）。改分辨率要同步改下面的常量。
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5556';
const PORT = process.env.PORT || '9223';
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const PKG = 'com.ysptv.player';

/* 物理像素常量（2400×1080 横屏，dpr 2.625） */
const VIDEO_TAP = [1400, 540];   // 视频区，远在面板右侧
const ROW_X     = 240;           // 面板中轴
const TAB0      = [119, 68];     // 「CCTV」tab 中心
const TAB1      = [361, 68];     // 「卫视」tab 中心

/* ---------- adb ---------- */
function adb(...a) {
  return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();
}
async function tap(x, y) {
  adb('shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y)));
  await sleep(700);
}
async function swipe(x1, y1, x2, y2, ms = 250) {
  adb('shell', 'input', 'swipe', String(Math.round(x1)), String(Math.round(y1)),
      String(Math.round(x2)), String(Math.round(y2)), String(ms));
  await sleep(1100);
}

/* ---------- CDP ---------- */
async function cdpConnect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
  if (!page) { console.error('找不到页面目标：', JSON.stringify(targets)); process.exit(1); }
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
  return {
    ws,
    async ev(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        throw new Error('JS 异常: ' + JSON.stringify(r.result.exceptionDetails));
      }
      return r.result.result.value;
    },
  };
}

/* ---------- 页面侧小工具 ---------- */
const JS_STATE = `JSON.stringify({
  panel: __yspTV.isPanelOpen(),
  tab: __yspTV.currentTab(),
  idx: __yspTV.index(),
  playing: __yspTV.playing(),
  count: __yspTV.count(),
  label: __yspTV.labels()[__yspTV.playing()] || '',
  first: __yspTV.labels()[0] || ''
})`;
const JS_SCROLL = `(function(){
  var l = document.querySelector('.tv-main-con-r-list-left');
  var rs = [].slice.call(l.children).filter(function(x){return x.offsetParent !== null;});
  if (!rs.length) return JSON.stringify({err:'no rows'});
  var lb = l.getBoundingClientRect(), b = rs[0].getBoundingClientRect();
  var rowH = b.height;
  var base = l.scrollTop + (b.top - lb.top);
  var off = (l.scrollTop - base) / rowH;          // 相对整行的偏移
  return JSON.stringify({
    scrollTop: Math.round(l.scrollTop * 100) / 100,
    rowH: Math.round(rowH * 1000) / 1000,
    offBy: Math.round((off - Math.round(off)) * rowH * 100) / 100,
    maxScroll: Math.round(l.scrollHeight - l.clientHeight)
  });
})()`;

/* ---------- 断言 ---------- */
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
  return ok;
}
function section(t) { console.log('\n' + t); }

/* ---------- 准备 ---------- */
const { ws, ev } = await cdpConnect();
const state = async () => JSON.parse(await ev(JS_STATE));

// ⚠️ 连上 CDP 不等于页面能用：注入是 MainActivity 在 onPageFinished 之后才做的，
//    之后还有 boot() 和 [1500,3000,5000,8000]ms 的四次重试去等频道容器出现。
//    这里以前是「连上就直接读状态」，页面还在加载时 JS_STATE 会抛
//    （`__yspTV` 还不存在），整条栈打出来像脚本坏了 —— 实测踩到过，
//    device_test.mjs 里同一个问题已经修过，这里同步补上：等到注入完成且列表有行。
{
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const s = await state();
      if (s && s.count > 0) { ready = true; break; }
    } catch (e) { /* 还没注入，继续等 */ }
    await sleep(1000);
  }
  if (!ready) {
    console.error('等了 60 秒页面里仍然没有 __yspTV / 频道列表 —— 注入真的失败了。');
    console.error('  先确认：' + SERIAL + ' 上已装 debug APK，且 MainActivity 已启动、9223 转发指向当前 pid。');
    process.exit(1);
  }
}

/** 面板开着就等它自动隐藏，保证从「收起」这个确定状态出发 */
async function collapse() {
  if ((await state()).panel) { await ev('__yspTV.closePanel()'); await sleep(400); }
}
async function openPanel() {
  await collapse();
  await tap(...VIDEO_TAP);
  if (!(await state()).panel) throw new Error('轻点没能弹出面板');
  // ⚠️ 光「状态是展开」还不够：面板是 transform 滑入的，
  //    而 rowY() 用 getBoundingClientRect 取坐标 —— 动画没走完时它给的是【正在移动中】的位置，
  //    点下去就会落到面板外（现象是「面板被收起、但没换台」，而不是报错）。
  //    所以这里等它的 left 连续两次读到同一个值（几何上停住了）再返回。
  //    实测：手机模拟器刚开机、系统还在忙的时候会踩到，第二遍跑就正常 —— 典型的时序抖动。
  let prev = null;
  for (let i = 0; i < 30; i++) {
    const left = await ev(`(function(){
      var p = document.querySelector('.tv-main-con-r');
      return p ? Math.round(p.getBoundingClientRect().left) : null;
    })()`);
    if (left !== null && left === prev) break;
    prev = left;
    await sleep(120);
  }
}
/**
 * 取第 n 行（可见行）中心的物理 y。
 *
 * ⚠️ 这里踩过一个很隐蔽的竞态，别再退回「读一次坐标就点」：
 *    面板一打开，inject.js 会把「正在播放」那一行滚进视野。这个滚动**可能发生在
 *    坐标读完之后**，于是点下去就落到隔壁行。
 *    实测症状极有辨识度 —— 目标第 5 行、实际选中第 4 行，而且日志里 y 读数是 438
 *    而不是 524，正好差整整一行（行高 85.7 物理 px）：
 *      · 读坐标那一刻 scrollTop=85.7 → rs[4] 的 rect 落在 438；
 *      · 读完列表又滚回 0 → 438 那个位置现在画的是 rs[3]。
 *    坐标换算本身没错（dpr 2.625，物理 y = CSS y × dpr，逐行验证过），
 *    错的只是「读完之后它又动了」。
 *
 *    所以：
 *      ① 先把 scrollTop 钉到 0 —— 滚动行为由 §6 的拖动用例单独覆盖，这里不需要它掺和；
 *      ② 等连续三次读数完全一致（约 450ms 没再动）才返回，而不是只比两次；
 *      ③ 用 elementFromPoint 反向确认这个点确实落在第 n 行里（行边界离中点只有约 43px，
 *         靠「大概对上」是不够的）。
 */
async function rowY(n) {
  const read = () => ev(`(function(){
    var l = document.querySelector('.tv-main-con-r-list-left');
    if (!l) return JSON.stringify({err:'no list'});
    l.scrollTop = 0;
    var rs = [].slice.call(l.children).filter(function(x){return x.offsetParent !== null;});
    if (!rs[${n}]) return JSON.stringify({err:'no row'});
    var b = rs[${n}].getBoundingClientRect();
    var cx = b.left + b.width / 2, cy = b.top + b.height / 2;
    var hit = document.elementFromPoint(cx, cy);
    return JSON.stringify({
      y: cy * devicePixelRatio,
      scroll: Math.round(l.scrollTop * 100) / 100,
      top: Math.round(b.top * 100) / 100,
      hitOk: !!(hit && (rs[${n}] === hit || rs[${n}].contains(hit)))
    });
  })()`);

  let a = null, b = null;
  for (let i = 0; i < 40; i++) {
    const r = JSON.parse(await read());
    if (r.err) return NaN;
    const same = (x, y) => x && y && x.scroll === y.scroll && x.top === y.top;
    if (same(a, r) && same(b, r) && r.hitOk && r.scroll === 0) return r.y;
    a = b; b = r;
    await sleep(150);
  }
  return b.y;
}

adb('logcat', '-c');
console.log('设备:', SERIAL, ' CDP 端口:', PORT);
console.log('起始状态:', JSON.stringify(await state()));

try {
  /* ============ 1. 轻点弹面板 ============ */
  section('【1】面板收起：轻点屏幕');
  await collapse();
  let s0 = await state();
  await tap(...VIDEO_TAP);
  let s1 = await state();
  check('轻点拨出选台面板', !s0.panel && s1.panel, `${s0.panel} → ${s1.panel}`);
  check('弹面板没有误换台', s1.playing === s0.playing, `playing ${s0.playing} → ${s1.playing}`);

  /* ============ 2. 面板外上滑 = 收起并换台 ============ */
  section('【2】面板展开：在视频区上滑');
  const before2 = await state();
  await swipe(VIDEO_TAP[0], 800, VIDEO_TAP[0], 320, 220);
  const after2 = await state();
  check('面板外上滑收起面板', !after2.panel, `panel=${after2.panel}`);
  check('同时换到下一台（不必先点再滑）',
    after2.playing === before2.playing + 1,
    `${before2.label} → ${after2.label}`);

  /* ============ 3. 收起态上下滑换台 ============ */
  section('【3】面板收起：上滑/下滑换台');
  await collapse();
  const b3 = await state();
  await swipe(VIDEO_TAP[0], 800, VIDEO_TAP[0], 300, 200);
  const a3 = await state();
  check('上滑 = 下一台', a3.playing === b3.playing + 1, `${b3.label} → ${a3.label}`);
  await swipe(VIDEO_TAP[0], 300, VIDEO_TAP[0], 800, 200);
  const c3 = await state();
  check('下滑 = 上一台', c3.playing === a3.playing - 1, `${a3.label} → ${c3.label}`);
  check('换台过程面板保持收起', !c3.panel);

  /* ============ 4. 点频道行选台 ============ */
  section('【4】面板展开：轻点频道行');
  await openPanel();
  const b4 = await state();
  const y4 = await rowY(4);
  // 同一时刻读出「坐标」和「那一行的名字」，tapping 之后按【名字】断言。
  // 理由：央视频是个会自己重渲染频道列表的 SPA，列表在「读坐标 → 真正点下去」
  // 这中间重排过一次的话，按行下标断言就会误报（实测三次里错一次）。
  // 「点某一行 → 选中该行对应的频道」才是这条用例真正要保证的事。
  const name4 = await ev(`(function(){
    var l = document.querySelector('.tv-main-con-r-list-left');
    var rs = [].slice.call(l.children).filter(function(x){return x.offsetParent !== null;});
    return rs[4] ? (rs[4].innerText || '').trim() : '';
  })()`);
  console.log(`     目标行 = 第 5 行「${name4}」  点击 y=${Math.round(y4)}  x=${ROW_X}`);
  await tap(ROW_X, y4);
  const a4 = await state();
  check('点第 5 行选中该台', !!name4 && a4.label === name4 && a4.label !== b4.label,
    `${b4.label} → ${a4.label}（期望「${name4}」playing=${a4.playing}）`);
  check('选中后面板自动收起', !a4.panel, `panel=${a4.panel}`);

  /* ============ 5. 点 tab 切 CCTV / 卫视 ============ */
  section('【5】面板展开：轻点 tab');
  await openPanel();
  const b5 = await state();
  await tap(...TAB1);
  await sleep(2800);                     // switchTab 的 settle 最晚 2600ms
  const a5 = await state();
  check('点「卫视」切到卫视频道列表',
    a5.tab === 1 && a5.count === 33 && /卫视/.test(a5.first),
    `tab ${b5.tab}→${a5.tab}, 首项「${a5.first}」, ${a5.count} 个`);
  check('切 tab 后面板仍展开', a5.panel, `panel=${a5.panel}`);

  await tap(...TAB0);
  await sleep(2800);
  const c5 = await state();
  check('点「CCTV」切回央视频道列表',
    c5.tab === 0 && c5.count === 40 && /CCTV/.test(c5.first),
    `tab ${a5.tab}→${c5.tab}, 首项「${c5.first}」, ${c5.count} 个`);

  /* ============ 6. 列表拖动 + 吸附整行 ============ */
  section('【6】面板展开：列表内拖动');
  await openPanel();
  const b6 = JSON.parse(await ev(JS_SCROLL));
  await swipe(ROW_X, 900, ROW_X, 380, 400);
  await sleep(900);                      // 等惯性滚完 + 吸附
  const a6 = JSON.parse(await ev(JS_SCROLL));
  check('拖动确实滚动了列表', a6.scrollTop > b6.scrollTop + 10,
    `scrollTop ${b6.scrollTop} → ${a6.scrollTop}（可滚 ${b6.maxScroll}）`);
  check('松手后吸附到整行（顶边不留半行）', Math.abs(a6.offBy) < 1.5,
    `行高 ${a6.rowH}，相对整行偏移 ${a6.offBy}px`);
  check('拖动过程面板没有被收起', (await state()).panel);

  /* ============ 7. 点面板外收起 ============ */
  section('【7】面板展开：轻点面板外');
  const before7 = await state();
  await tap(1900, 300);
  const after7 = await state();
  check('点面板外收起面板', !after7.panel, `panel=${after7.panel}`);
  check('收起时没有误换台', after7.playing === before7.playing,
    `playing ${before7.playing} → ${after7.playing}`);

  /* ============ 8. 遥控器路径未受影响 ============ */
  section('【8】遥控器路径（回归：别被触摸层带坏）');
  await collapse();
  const b8 = await state();
  adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_DOWN');
  await sleep(700);
  const a8 = await state();
  check('下键仍然换台', a8.playing === b8.playing + 1, `${b8.label} → ${a8.label}`);

  adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_CENTER');
  await sleep(800);
  const d8 = await state();
  check('确认键仍然弹出面板', d8.panel);

  // 用下键验证「只移光标不换台」：光标此时停在第 0 行，再往上按会被 clamp 住，
  // 断言 idx-1 会假失败（之前就踩过这个坑）。
  adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_DOWN');
  await sleep(600);
  adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_DOWN');
  await sleep(600);
  const e8 = await state();
  check('面板展开时下键只移光标、不换台',
    e8.idx === d8.idx + 2 && e8.playing === d8.playing,
    `idx ${d8.idx}→${e8.idx}, playing 保持 ${e8.playing}`);
  adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_UP');
  await sleep(600);
  const f8 = await state();
  check('面板展开时上键同样只移光标',
    f8.idx === e8.idx - 1 && f8.playing === e8.playing,
    `idx ${e8.idx}→${f8.idx}, playing 保持 ${f8.playing}`);

  /* ============ 9. 稳定性 ============ */
  section('【9】稳定性');
  const fatal = (adb('shell', 'logcat', '-d') || '').split('\n').filter(l => /FATAL EXCEPTION/.test(l));
  check('全程无崩溃', fatal.length === 0, `FATAL=${fatal.length}`);
} finally {
  await collapse();
  ws.close();
}

/* ---------- 汇总 ---------- */
const pass = results.filter(r => r.ok).length;
console.log('\n' + '='.repeat(62));
console.log(`结果： ${pass}/${results.length} 通过`);
if (pass !== results.length) {
  console.log('\n未通过项：');
  results.filter(r => !r.ok).forEach(r => console.log('  ❌ ' + r.name + '   — ' + r.detail));
}
console.log('='.repeat(62));
process.exit(pass === results.length ? 0 : 2);
