#!/usr/bin/env node
/* ============================================================
   换台节流（v1.7）验证

   背景：站点自研 WASM HLS 播放器（hls.cmg.js）在换台时走
   detachMedia → moduleActive，高频连按会读到一个 null 的 .length 抛
   TypeError，把「卸旧源 → 挂新源」拦腰截断，video.src 被清空后再也挂不上，
   播放器永久死掉（再点任意行也救不回来）。
   实测：单次换台间隔 2.5s×10 次 0 死；120ms 连按 6 次会死。
   对策：inject.js 的 fireSwitch() 加 1.5s 阀门，间隔内只更新目标不叠发。

   两段：
     [静态]  源码里节流机制的关键形态（正则正向断言，先验证过能匹配）
     [设备]  真机行为：单键零延迟、连按只发一车、按回当前台撤单、
             切 tab 撤单、连按 6 次后播放器仍然活着

   v1.13 起静态段额外盯四件「手感」优化的形态（都不需要设备）：
     阀门提前解锁（含硬下限 + 到点兜底）、playerSettled 判据、
     换台气泡守到出画、收起态一次按键只算一次 rows() 且不画光标。

   用法：
     node tools/switch_throttle_test.mjs            # 全跑
     node tools/switch_throttle_test.mjs static     # 只跑静态段（无需设备）
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const CDP = 'http://127.0.0.1:9222';
const MODE = process.argv[2] || 'all';

const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
  return ok;
}
function section(t) { console.log(`\n=== ${t} ===`); }
function adb(...a) { return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim(); }

/* ================= 静态段 ================= */
if (MODE === 'static' || MODE === 'all') {
  section('静态：节流机制形态');
  const js = readFileSync(path.join(ROOT, 'tools', 'inject.js'), 'utf8');

  check('阀门常量 SWITCH_GAP_MS = 1500（实测站点首帧 1.3–1.6s，取 1.5s）',
    /var SWITCH_GAP_MS\s*=\s*1500\s*;/.test(js));
  check('fireSwitch 按 switchGateUntil 判是否放行',
    /var wait = switchGateUntil - Date\.now\(\);/.test(js));
  check('阀门未开会立刻发车（单键零延迟）',
    /if \(wait <= 0\) \{[\s\S]{0,80}switchGateUntil = Date\.now\(\) \+ SWITCH_GAP_MS;[\s\S]{0,60}activateAt\(target\)/.test(js)
    || /if \(wait > 0\) \{[\s\S]{0,200}\}[\s\S]{0,80}switchGateUntil = Date\.now\(\)/.test(js));
  check('阀门关着时只排队、不叠发（switchWant + setTimeout）',
    /switchWant = target;[\s\S]{0,120}switchTimer = setTimeout\(/.test(js));
  check('move() 收起态改走 debounceSwitch，不再直接 activateAt（v1.12 防抖）',
    /debounceSwitch\(target\);/.test(js));
  // 防抖挂起时车还没进阀门，switchWant 是 -1 —— 只认它会把连按的位移吞掉。
  check('续算基点同时认阀门里的 switchWant 和防抖里的 debWant',
    /intend = \(switchWant >= 0\) \? switchWant/.test(js)
    && /switchDebTimer && debWant >= 0/.test(js)
    && /if \(intend >= 0\) target = clamp\(intend \+ d, rs\.length\);/.test(js));
  check('按回当前正在播的台 → 撤掉待发车（防抖也要一起撤）',
    /if \(target === cur\) \{ cancelSwitch\(\); clearDebounce\(\); return idx; \}/.test(js)
    && /function cancelSwitch\(\)[\s\S]{0,300}clearDebounce\(\);/.test(js));
  check('防抖窗口 250ms 上下（有取值范围，别被改成固定 1 秒那种手感）',
    /SWITCH_DEBOUNCE_MS = 250;/.test(js)
    && /setSwitchDebounce: function/.test(js));
  check('activate() 选中行也过阀门',
    /var ok = fireSwitch\(idx\);/.test(js));
  check('switchTab 先撤待发车再点 tab（旧 tab 的目标不能留）',
    /cancelSwitch\(\);\s*\n\s*fireClick\(t\[i\]\);/.test(js));
  check('switchTab 之后把阀门压到 SWITCH_GAP_MS 之后',
    /switchGateUntil = Date\.now\(\) \+ SWITCH_GAP_MS;/.test(js));
  check('cancelSwitch / flushSwitch 都存在',
    /function cancelSwitch\(\)/.test(js) && /function flushSwitch\(\)/.test(js));
  check('导出 setSwitchGap / switchPending / switchGateLeft 供测试调参',
    /setSwitchGap: function \(ms\)/.test(js) && /switchPending: function \(\)/.test(js) && /switchGateLeft: function \(\)/.test(js));
  check('注释里记了实测依据（wedge_repro / detachMedia）',
    /detachMedia/.test(js) && /120ms 连按 6 次/.test(js));

  /* ---- v1.13 换台手感优化 ---- */
  check('排队期间有提前解锁：站点一出画就发，不必傻等满阀门',
    /armEarlyUnlock\(wait\);/.test(js) && /function armEarlyUnlock\(/.test(js));
  check('提前解锁有硬下限：两次碰站点播放器至少隔 60% 阀门',
    /var floor = Math\.round\(SWITCH_GAP_MS \* 0\.6\);/.test(js));
  check('提前解锁到点仍然照发（判不出就绪时行为同老逻辑，不会死等）',
    /var left = deadline - Date\.now\(\);[\s\S]{0,120}left <= 0/.test(js));
  check('playerSettled 判据：readyState>=3 / 未暂停 / 网络空闲 / 有画面',
    /if \(v\.readyState < 3\) return false;/.test(js)
    && /if \(v\.paused\) return false;/.test(js)
    && /if \(v\.networkState !== 1\) return false;/.test(js)
    && /return v\.currentTime > 0 && v\.videoWidth > 0;/.test(js));
  check('提前解锁发车时也清 unlockTimer，不会和「到点发车」叠发',
    /if \(unlockTimer\) \{ clearTimeout\(unlockTimer\); unlockTimer = 0; \}/.test(js));
  check('cancelSwitch / flushSwitch 也撤提前解锁（按回当前台不能残留）',
    /function cancelSwitch\(\)[\s\S]{0,200}clearTimeout\(unlockTimer\)/.test(js)
    && /function flushSwitch\(\)[\s\S]{0,200}clearTimeout\(unlockTimer\)/.test(js));
  check('换台气泡守到出画再撤（showToastHold），且换台两条路都用它',
    /function showToastHold\(/.test(js)
    && /showToastHold\(labelAt\(target, rs\)\);/.test(js)
    && /showToastHold\(name\);/.test(js));
  check('收起态一次按键只算一次 rows()（playingIndex / labelAt 收快照传下去）',
    /var cur = playingIndex\(rs\);/.test(js) && /labelAt\(target, rs\)/.test(js));
  check('收起态不再 paint(false)：面板在屏幕外，画光标是白费',
    /if \(panelOpen\) paint\(true\);/.test(js));
  check('导出 playerSettled 供测试读取',
    /playerSettled: playerSettled,/.test(js));
}

/* ================= 设备段 ================= */
async function cdp() {
  const targets = await (await fetch(CDP + '/json')).json();
  const page = targets.find(t => t.type === 'page' && /yangshipin/.test(t.url));
  if (!page) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const pending = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 15000);
    pending.set(id, m => { clearTimeout(timer); res(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (x) => (await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const snap = async () => JSON.parse(await ev(`(function(){var v=document.querySelector('video');return JSON.stringify({idx:__yspTV.index(),playing:__yspTV.playing(),rows:__yspTV.count(),pend:__yspTV.switchPending(),gate:__yspTV.switchGateLeft(),rs:v.readyState,ns:v.networkState,src:(v.src||'').length,paused:v.paused,ct:Math.round(v.currentTime*100)/100});})()`) || '{}');
  return { ws, send, ev, snap };
}
const isDead = h => h.rs === 0 || h.src === 0 || h.ns === 0;

if (MODE === 'device' || MODE === 'all') {
  section('设备：节流行为');

  /* 先确保前台是主界面、页面已就绪 */
  adb('shell', 'am', 'start', '-n', 'com.ysptv.player/.MainActivity');
  await sleep(3000);
  const c = await cdp();
  if (!c) { console.log('  ❌ 找不到页面 target，设备段跳过'); }
  else {
    await c.send('Runtime.enable');
    let h = await c.snap();
    if (!h.rows) { console.log('  ❌ 页面未就绪（rows=0），设备段跳过'); c.ws.close(); }
    else {
      /* 归位到列表中段：先切 tab，再等落定 */
      if (h.playing < 5 || h.playing > h.rows - 6) {
        await c.ev('__yspTV.switchTab(0)');
        await sleep(4500);
        h = await c.snap();
      }
      const base = h.playing >= 0 ? h.playing : 0;
      console.log(`  起点：playing=${base}/${h.rows}`);

      /* --- 1. 单键零延迟 --- */
      /* ⚠️ v1.12 加了防抖：单键不再是"零延迟"，而是"等按键停下来"。
         断言随之改成「在防抖窗口 + 出画时间内跟上了」——
         精确等一个时间阈值只会让这条测试在机器慢一点时就假失败。 */
      const t0 = Date.now();
      adb('shell', 'input', 'keyevent', '20');
      let single = null;
      for (let k = 0; k < 20; k++) {
        await sleep(150);
        const s = await c.snap();
        if (s.playing !== base) { single = { dt: Date.now() - t0, to: s.playing }; break; }
      }
      check('单次按 DOWN：停下按键后很快跟着变（不超过防抖窗口 + 出画时间）',
        !!single && single.dt < 4000, single ? `${single.dt}ms 后 ${base}→${single.to}` : 'playing 未变');
      const afterOne = await c.snap();
      check('单次按 DOWN 后无待发车残留', afterOne.pend === -1, `pend=${afterOne.pend}`);
      /* ⚠️ v1.12：这条跟着防抖改了语义，但【不能】钉「gate 必须 === 0」——
         250ms 防抖 vs 上面轮询的 150ms 间隔，正好卡在竞态边界上：
         慢一点的机器上多轮询一轮就已经发车了（gate>0），会变成间歇性假失败。
         「按键期间没发车」这件事由 switch_debounce_test.mjs 用
         「连按 5 次期间 playing 原地不动」来钉，那是不依赖时序的强证据。
         这里只保证「没有残留的待发车」—— 那一项跟防抖无关，一直都该成立。 */

      /* 停手之后（防抖窗口已过）阀门必须压上了 —— 这是「防抖没把车吞掉」的证据 */
      await sleep(1200);
      const afterSettle = await c.snap();
      check('停手后车发出去、阀门压上（防抖没把车吞掉）', afterSettle.gate > 0,
        `gate=${afterSettle.gate}ms`);

      /* --- 2. 连按只发一车 --- */
      await sleep(1600);                       // 等阀门过期，保证 burst 的第一按立刻发车
      const b2 = await c.snap();
      const from = b2.playing;
      for (let i = 0; i < 5; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
      const mid = await c.snap();
      check('连按 5 次：光标 idx 全部跟上（+5）', mid.idx === from + 5, `idx=${mid.idx} 期望 ${from + 5}`);
      /* v1.12 的语义：防抖期间【一次都不发车】——
         之前是「第一按立刻发、剩下 4 按被阀门吃」，站点播放器仍被惊动 1 次；
         现在按键期间站点完全没被碰过（playing 原地不动），
         停手后才发一趟、而且直接落到最后一台。
         这就是「不卡」的来源：反复 detach/mount 站点那个 WASM 播放器才是卡顿的根。*/
      check('连按 5 次：按键期间站点一次都没被惊动（playing 原地不动）',
        mid.playing === from, `playing=${mid.playing} 起点 ${from}`);
      await sleep(2200);
      const done = await c.snap();
      check('停手后落到最后一台（且待发车已清）',
        done.playing === from + 5 && done.pend === -1,
        `playing=${done.playing} pend=${done.pend} 期望 ${from + 5}`);

      /* --- 3. 按回当前台撤单 ---
         ⚠️ 前提必须是"阀门关着"，否则第一按就发车了、根本攒不下单。
         所以先按一次 DOWN 把阀门压上，再按 UP 攒单，再按 DOWN 按回当前台。 */
      /* ⚠️ v1.12：这两条的【语义变了】。
         原来测的是「阀门关着时按 UP 攒单，再按 DOWN 按回当前台 → 撤单」。
         现在 move() 先进防抖（250ms），按键期间 switchWant 一直是 -1 ——
         「攒单」这个中间态要等防抖窗口过去、车进了阀门才存在。
         所以断言改成两条真正要保证的东西：
           ① 停手 → 车进阀门（pend 出现）
           ② 「按回当前台」→ 防抖被撤掉，站点一台都没换 */
      /* ⚠️ 「停手才换台」与「按回当前台撤单」这两组已移出本套件 ——
         它们的断言依赖「光标/播放都在第 0 台附近」这个前提，而本套件跑到这里
         光标已经被前面的用例推到二十几台（起点假设失效，测的是别的位置）。
         同样的语义改由 tools/switch_debounce_test.mjs 从干净起点覆盖，
         那边是专门为此新建的（6 条断言，含「按键期间站点一次都没被惊动」）。

         本套件保留的是它本来该管的东西：门���上限、连按不叠发、播放器不死。 */

      /* 等这次 tab 切换真正落定再连按，否则会把"切换还没完成"算到连按头上 */
      for (let k = 0; k < 20; k++) {
        await sleep(500);
        const s = await c.snap();
        if (s.rs >= 3 && s.ct > 0.5) break;
      }

      /* --- 5. 连按 6 次后播放器仍活着（本节的核心） ---
         ⚠️ 判死必须【连续 6 次采样都死（约 3 秒）】才算：合法换台时站点要卸旧源、
         重新挂新源，readyState 掉到 0 的窗口实测有 1.3–1.6s，按 500ms 采样正好
         能凑满 3 次 —— 我用 3 次当阈值被连骗两次（测试连报"死亡"，实际播得好好的）。
         3 秒是实测重 sourcing 上限（1.6s）的约两倍，真死一样抓得到，只是晚 3 秒。 */
      await sleep(1200);
      for (let i = 0; i < 6; i++) { adb('shell', 'input', 'keyevent', '20'); await sleep(120); }
      let alive = null, deadRun = 0;
      for (let k = 0; k < 40; k++) {
        await sleep(500);
        const s = await c.snap();
        if (s.pend === -1 && s.rs >= 3 && s.ct > 0.5) { alive = s; break; }
        if (isDead(s)) { deadRun++; if (deadRun >= 6) { alive = null; break; } }
        else deadRun = 0;
      }
      check('120ms 连按 6 次后播放器仍然活着（修复前约 1/5 概率永久死掉）',
        !!alive, alive ? `rs=${alive.rs} ct=${alive.ct} playing=${alive.playing}` : '播放器持续死亡');
      check('连按 6 次后当前播放下标与光标一致',
        !!alive && alive.playing === alive.idx, alive ? `idx=${alive.idx} playing=${alive.playing}` : 'n/a');
      c.ws.close();
    }
  }
}

/* ================= 汇总 ================= */
section('汇总');
const pass = results.filter(r => r.ok).length;
console.log(`  ${pass}/${results.length} 通过`);
results.filter(r => !r.ok).forEach(r => console.log(`  ❌ ${r.name}   — ${r.detail || ''}`));
process.exit(pass === results.length ? 0 : 1);
