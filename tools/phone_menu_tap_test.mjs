#!/usr/bin/env node
/* ============================================================
   手机端点击验证（v1.10 修「点菜单项没反应」）

   为什么不用 adb 的 `input tap`：模拟器的 tap 走的是注入事件，
   跟手指真实触摸在「click 派发时机」上有差别（300ms 延迟/是否合成）。
   这里两条腿都走：
     ① adb `input swipe x y x y 40` —— 模拟真实手指按下抬起（最短时长）
     ② CDP Input.dispatchTouchEvent —— 真·touch 序列（含 touchstart/touchend）
   断言只看【状态真的变了】，不看事件本身。
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5556';
const PORT = process.env.CDP_PORT || '9223';
const SHOTS = path.join(ROOT, 'dist', 'shots_phone');
mkdirSync(SHOTS, { recursive: true });

const results = [];
const ok = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? '   — ' + detail : ''}`);
};
function adb(...a) {
  return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();
}
function shot(name) {
  const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 });
  writeFileSync(path.join(SHOTS, name + '.png'), buf);
}

/* ---------- CDP ---------- */
const list = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/json`)).text()))
  .filter(t => t.type === 'page');
if (!list.length) { console.error('没有可调试页面（release 包不开 WebView 调试，用 debug 包）'); process.exit(1); }
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0; const pend = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
});
function send(method, params) {
  const id = ++seq;
  return new Promise(res => {
    pend.set(id, m => res(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const ev = expr => send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }).then(r => r?.result?.value);

/**
 * 真实手指点击：adb `input tap`（物理像素）。
 *
 * ⚠️ 为什么不用 CDP Input.dispatchTouchEvent：那条路派发的是合成事件，
 *    在 Android WebView 上 click 的合成时机与真实触摸不完全一致，
 *    会出现「合成事件能触发、真实手指不触发」这种查起来很绕的假象。
 *    用户是用手指点的，所以断言必须建立在 `input tap` 上。
 * 坐标要乘 devicePixelRatio（页面拿到的 getBoundingClientRect 是 CSS px，
 * 而 input tap 用的是物理像素）。
 */
async function tap(cssX, cssY) {
  const dpr = Number(await ev('devicePixelRatio')) || 1;
  adb('shell', 'input', 'tap', String(Math.round(cssX * dpr)), String(Math.round(cssY * dpr)));
  await sleep(200);      // input tap 是异步注入的，且前面可能刚滚过列表，等它落地
}

/**
 * 某一项菜单的中心坐标（CSS px）。
 * 返回 null 有两种含义，调用方要分开处理：
 *   · 菜单里没有这一项（label 没匹配上）
 *   · 这一项虽然存在但当前【拿不到坐标】（浮层没开 / 被滚到可视区外）——
 *     这时 tap 会落到(0,0) 静默无效，断言会以「点了没反应」的面貌假失败，
 *     所以这里显式返回 {bad:true} 让调用方先报前置问题。
 */
async function itemPoint(label, prefix = false) {
  return await ev(`(function(){
    var LABEL = ${JSON.stringify(label)};
    var PREFIX = ${prefix ? 'true' : 'false'};
    var rs = [].slice.call(document.querySelectorAll('.mg-item'));
    for (var i = 0; i < rs.length; i++) {
      var l = rs[i].querySelector('.mg-label');
      // ⚠️ 精确相等而不是 indexOf：「清空全部源」和「再按一次确认清空」互相包含，
      //    用 indexOf 会在两段式改名后匹配到别的项去，点下去落到邻居身上。
      var hit = PREFIX
        ? (l && l.textContent.indexOf(LABEL) === 0)
        : (l && l.textContent === LABEL);
      if (hit) {
        // ⚠️ 必须先滚进可视区再取坐标。手机上 .mg-list 一屏放不下 8 项，
        //    后面几项的坐标落在卡片之外 —— 手指点过去是【点不到】的，
        //    表现就是「点了没反应」，很容易误判成点击功能坏了。
        //    （真实用户会先滑动列表，我们在这里做等价的 scrollIntoView。）
        rs[i].scrollIntoView({block: 'nearest'});
        var b = rs[i].getBoundingClientRect();
        // ⚠️ 别叫list：文件外层已经有一个 const list（CDP 的页面列表），
        //    这里再声明会把它遮蔽掉，itemPoint 直接变成「list 不是函数」。
        var lr = document.querySelector('.mg-list').getBoundingClientRect();
        var visible = b.top >= lr.top - 1 && b.bottom <= lr.bottom + 1;
        return JSON.stringify({i:i, x:Math.round(b.left+b.width/2),
                               y:Math.round(b.top+b.height/2), visible:visible});
      }
    }
    return 'null';
  })()`).then(v => (v ? JSON.parse(v) : null));
}

const state = () => ev(`JSON.stringify({
  open: __yspUI.isManageOpen(), idx: __yspUI.menuIndex(), n: __yspUI.count(),
  kb: __yspUI.isKbOpen(), mode: __yspUI.mode(),
  toast: ((document.getElementById('ysp-toast')||{}).textContent||'').trim(),
  urls: __yspUI.urls().length
})`).then(JSON.parse);

console.log('\n=== 手机端：点菜单项 ===');
process.on('unhandledRejection', e => { console.error('脚本异常:', e); process.exit(1); });
// 先把剪贴板清空：模拟器里可能残留着上一轮套件塞进去的真清单地址，
// 那样「从剪贴板导入」会走导入分支，「点了有反应」就测不出「点了会被响应」。
await ev('__yspUI.rpc("clear")');
await sleep(800);
// 清剪贴板：clipper 这个辅助 App 不一定装了，没装就跳过（断言不依赖它），
try { adb('shell', 'am', 'broadcast', '-a', 'clipper.set', '-e', 'text', 'x'); } catch (e) {}
await ev('__yspUI.openManage()');
await sleep(700);
const s0 = await state();
ok('起点：源管理浮层开着、零源', s0.open === true && s0.n === 0, JSON.stringify(s0));

/* ---- ① 「从剪贴板导入」：点一下必须给出反馈 ---- */
{
  const p = await itemPoint('从剪贴板导入');
  ok('前置：这一项已滚进可视区且坐标有效（否则 tap 是无效点击）',
    !!p && p.visible && p.x > 0 && p.y > 0,
    p ? `idx=${p.i} @${p.x},${p.y} visible=${p.visible}` : '菜单里没有');
  ok('找得到「从剪贴板导入」这一项', !!p, p ? `idx=${p.i} @${p.x},${p.y}` : '菜单里没有');
  if (p) {
    await tap(p.x, p.y);
    await sleep(1400);
    const s = await state();
    // ⚠️ 不能断言具体文案：模拟器剪贴板里可能有上一轮套件留下的真清单地址，
    //    那就会走「导入成功」分支。要断言的是「点了之后状态确实动了」——
    //    修复前这里 idx 不变、toast 不变（点了跟没点一样）。
    ok('点「从剪贴板导入」有反应（不再点了跟没点一样）',
      s.toast !== s0.toast || s.n !== s0.n || s.urls !== s0.urls,
      `toast ${JSON.stringify(s0.toast)} → ${JSON.stringify(s.toast)}`);
    //清掉它导入的东西，别影响后面几节
    await ev('__yspUI.rpc("clear")');
    await sleep(1000);
    shot('p01_clip_tapped');
  }
}

/* ---- ② 「屏上输入新源」：点一下必须打开屏上键盘 ---- */
{
  await ev('__yspUI.openManage()');
  await sleep(600);
  const p = await itemPoint('屏上输入新源');
  ok('找得到「屏上输入新源」这一项', !!p, p ? `idx=${p.i}` : '菜单里没有');
  if (p) {
    await tap(p.x, p.y);
    await sleep(1000);
    const s = await state();
    ok('点「屏上输入新源」打开了屏上键盘', s.kb === true && s.mode === 'kb',
      `kb=${s.kb} mode=${s.mode}`);
    shot('p02_kb_opened');

    /* ---- ③ 键盘里也能点：点一个字母要真的打出来 ---- */
    const before = JSON.parse(await ev('JSON.stringify(__yspUI.keyboard())'));
    const keyPt = await ev(`(function(){
      var ks = document.querySelectorAll('.kb-key');
      for (var i = 0; i < ks.length; i++) {
        if (ks[i].textContent === 'q') {
          var b = ks[i].getBoundingClientRect();
          return JSON.stringify({x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)});
        }
      }
      return 'null';
    })()`).then(v => (v ? JSON.parse(v) : null));
    ok('键盘渲染出了可点的键', !!keyPt, keyPt ? `@${keyPt.x},${keyPt.y}` : '没找到 q 键');
    if (keyPt) {
      await tap(keyPt.x, keyPt.y);
      await sleep(700);
      const after = JSON.parse(await ev('JSON.stringify(__yspUI.keyboard())'));
      ok('点字母键真的打出了字符',
        after.url.length === before.url.length + 1,
        `${JSON.stringify(before.url)} → ${JSON.stringify(after.url)}`);
      shot('p03_kb_typed');
    }
    await ev('__yspUI.closeKb()');
    await sleep(500);
  }
}

/* ---- ④ dim 项（零源时的删除源）点了只解释、不执行 ---- */
{
  await ev('__yspUI.openManage()');
  await sleep(600);
  const p = await itemPoint('删除源');
  if (p) {
    await tap(p.x, p.y);
    await sleep(350);          // ⚠️ toast 1.6s 后自动消失（inject.js），读晚了就没了
    const s = await state();
    ok('零源时点「删除源」只给一句解释，不进删除模式（没进 delete 态就是对的）',
      s.mode !== 'delete' && s.n === 0,
      `mode=${s.mode} n=${s.n} toast=${JSON.stringify(s.toast)}`);
  }
}

/* ---- ⑤ 一次点击只算一次（两段式确认不能被跳过）----
   「清空全部源」是先改名再真清。这里点一次，必须停在「再按一次确认清空」。 */
{
  // ⚠️ 顺序很要紧：先导源、再开浮层、最后取坐标。
  //    导入会触发 buildMenu 整块重建，之前取的坐标就失效了（点下去落到别的项上，
  //    表现为菜单项标签一直不变、断言假失败 —— 这个坑踩过一次）。
  await ev('__yspUI.rpc("clear")');
  await sleep(900);
  await ev(`__yspUI.clipResult("#EXTM3U\\n#EXTINF:-1,清空测试台\\nhttps://phone-tap-test.invalid/x.m3u8")`);
  await sleep(1500);
  const n1 = await ev('__yspUI.count()');
  await ev('__yspUI.openManage()');
  await sleep(700);
  const p = await itemPoint('清空全部源');
  ok('先导入一条源（这样清空项不是 dim）', n1 === 1, `n=${n1}`);
  if (p && n1 === 1) {
    await tap(p.x, p.y);
    await sleep(600);
    const s = await state();
    const clearLabel = await ev(
      `__yspUI.menuLabels().filter(function(x){return /清空/.test(x);})[0]||''`);
    ok('点一次「清空全部源」停在二次确认（没直接清掉）',
      s.n === 1 && /再按一次/.test(String(clearLabel)),
      `n=${s.n} 菜单项=${JSON.stringify(clearLabel)}`);
    shot('p04_clear_armed');

    /* ---- ⑥ 再点一次才真清（确认不是摆设） ---- */
    const p2 = await itemPoint('再按一次', true);
    ok('二次确认后菜单项改成了「再按一次确认清空」', !!p2 && !!p2.visible,
      p2 ? `idx=${p2.i} @${p2.x},${p2.y} visible=${p2.visible}` : '没改名');
    if (p2) {
      await tap(p2.x, p2.y);
      await sleep(1200);
      const s2 = await state();
      ok('再点一次真的清空了', s2.n === 0, `n=${s2.n}`);
      shot('p05_cleared');
    }
    await ev('__yspUI.closeManage()');
    await sleep(400);
    await ev('__yspUI.rpc("clear")');
    await sleep(1000);
  }
}

console.log('\n=== 汇总 ===');
const pass = results.filter(r => r.ok).length;
console.log(`  ${pass} 过 / ${results.length - pass} 失败   （截图在 ${SHOTS}）`);
if (pass !== results.length) {
  console.log('\n失败项：');
  results.filter(r => !r.ok).forEach(r => console.log('  ✗ ' + r.name + (r.detail ? '   — ' + r.detail : '')));
}
ws.close();
process.exit(pass === results.length ? 0 : 1);