#!/usr/bin/env node
/* ============================================================
   v1.11 端到端：订阅的「同步删除」与「退订」（TV API 34）

   验的是真链路：局域网导入页 /api/addurl → 记住清单 → 改上游内容 →
   点「同步这份清单」→ 该删的被删掉 → 「退订这份清单」→ 整份消失。

   为什么必须真跑：planSync 的边界逻辑宿主单测已经覆盖了 24 条，
   这里要补的是「Android 侧那条路有没有真的走到 syncFrom」——
   桥没接对、地址没记住、菜单项没触发，宿主单测一概看不见。
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const adb = (...a) => execFileSync(ADB, ['-s', SERIAL, ...a],
  { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PORT = 9222;
const results = [];
const ok = (n, c, d = '') => { results.push({ n, ok: !!c, d });
  console.log(`  ${c ? '✓' : '✗'} ${n}${d ? '   — ' + d : ''}`); };
const SHOTS = path.join(ROOT, 'dist/shots_v111');
mkdirSync(SHOTS, { recursive: true });
const shot = name => writeFileSync(path.join(SHOTS, name + '.png'),
  execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 }));

/* ---------- CDP ---------- */
let ws, seq = 0; const pend = new Map();
async function cdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = JSON.parse((await (await fetch(`http://127.0.0.1:${PORT}/json`)).text()))
        .filter(t => t.type === 'page');
      if (list.length) {
        ws = new WebSocket(list[0].webSocketDebuggerUrl);
        await new Promise(r => ws.addEventListener('open', r));
        ws.addEventListener('message', e => {
          const m = JSON.parse(e.data);
          if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
        });
        return true;
      }
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  return false;
}
const ev = expr => {
  const id = ++seq;
  return new Promise(res => {
    pend.set(id, m => res(m.result?.result?.value));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
};
const snap = () => ev(`JSON.stringify({
  n: __yspUI.count(), names: __yspUI.names(), groups: __yspUI.groups(),
  remote: __yspUI.remoteUrl(), menu: __yspUI.menuLabels()
})`).then(JSON.parse);

/* ---------- 桩：一份可以随时改内容的清单 ---------- */
let CONTENT = '';
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  res.end(CONTENT);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const STUB_PORT = srv.address().port;
const LIST_URL = `http://127.0.0.1:${STUB_PORT}/cn.m3u8`;
// 模拟器里的 127.0.0.1 是它自己 —— 换成宿主可达的 10.0.2.2
const DEVICE_URL = LIST_URL.replace('127.0.0.1', '10.0.2.2');

const m3u = (...rows) => '#EXTM3U\n' + rows.map(r =>
  `#EXTINF:-1 group-title="${r[2]}",${r[0]}\nhttp://x.invalid/${r[1]}.m3u8`).join('\n') + '\n';

console.log('\n=== v1.11 端到端：同步删除 + 退订 ===');
if (!await cdp()) { console.error('WebView 没起来'); process.exit(1); }

await ev('__yspUI.rpc("clear")');
await sleep(800);
await ev('__yspUI.closeManage()');
await sleep(400);

/* ---- ① 导入一份 4 条的清单（走局域网导入页那条真实通道） ---- */
CONTENT = m3u(['台A', 'a', '央视'], ['台B', 'b', '央视'],
              ['台C', 'c', '卫视'], ['台D', 'd', '卫视']);
await ev(`__yspUI.rpc("lanStart")`);
await sleep(2500);
let lan = await ev('__yspUI.lanUrl()');
const m = (lan || '').match(/:(\d+)\//);
ok('局域网导入服务已起', !!m, lan || '(空)');
if (m) {
  try { adb('forward', '--remove', 'tcp:8099'); } catch (e) {}
  adb('forward', 'tcp:8099', `tcp:${m[1]}`);
  const BASE = 'http://127.0.0.1:8099';
  const r1 = await fetch(`${BASE}/api/addurl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'url=' + encodeURIComponent(DEVICE_URL),
  }).then(r => r.json()).catch(e => ({ ok: false, msg: String(e) }));
  await sleep(2500);
  let s = await snap();
  ok('整份清单导入成功（4 条）', r1.ok === true && s.n === 4,
    `${JSON.stringify(r1).slice(0, 90)} / n=${s.n}`);
  ok('清单地址被记住了', /cn\.m3u8$/.test(s.remote || ''), s.remote);
  ok('菜单里出现「同步这份清单」和「退订这份清单」',
    s.menu.includes('同步这份清单') && s.menu.includes('退订这份清单'), s.menu.join(' | '));
  await ev('__yspUI.openManage()');
  await sleep(700);
  shot('v111_menu_unlist_item');
  await ev('__yspUI.closeManage()');
  await sleep(400);
  shot('v111_before_sync');

  /* ---- ② 手加一条（不属于这份清单）→ 同步时它必须活下来 ---- */
  await ev(`__yspUI.clipResult("https://my-own.invalid/manual.m3u8")`);
  await sleep(1500);
  s = await snap();
  ok('再手加一条不属于清单的源', s.n === 5, `n=${s.n}`);

  /* ---- ③ 上游把 台B/台D 下架了 + 加了 台E → 同步 ---- */
  CONTENT = m3u(['台A', 'a', '央视'], ['台C', 'c', '卫视'],
                ['台E', 'e', '卫视']);
  adb('logcat', '-c');
  await ev('__yspUI.openManage()');
  await sleep(600);
  await ev('__yspUI.rpc("refresh")');
  await sleep(4000);
  s = await snap();
  const lg = adb('logcat', '-d', '-s', 'YSPTV:V');
  ok('同步后总数正确：4 旧 -2 下架 +1 新 = 3，再加手加那条 = 4',
    s.n === 4, `n=${s.n} ${s.names.join('/')}`);
  ok('上游下架的台B/台D 被删掉了',
    !s.names.includes('台B') && !s.names.includes('台D'), s.names.join('/'));
  ok('上游新增的台E 补进来了', s.names.includes('台E'), s.names.join('/'));
  ok('手加的那条【没有被】同步删掉（边界：只删属于这份清单的）',
    s.names.some(n => /my-own/.test(n)), s.names.join('/'));
  const syncMsg = (lg.match(/清单已更新：[^\n]*/) || [''])[0];
  ok('提示里说清了「删了几条」', /删掉 2 条/.test(syncMsg), syncMsg.slice(0, 110));
  await ev('__yspUI.openManage()');
  await sleep(700);
  shot('v111_after_sync');
  await ev('__yspUI.closeManage()');
  await sleep(400);

  /* ---- ④ 退订 ---- */
  await ev('__yspUI.openManage()');
  await sleep(600);
  await ev('__yspUI.rpc("unlist")');
  await sleep(3000);
  s = await snap();
  ok('退订后只剩手加的那条', s.n === 1 && /my-own/.test(s.names[0] || ''),
    `n=${s.n} ${s.names.join('/')}`);
  ok('退订把清单地址也清掉了（不然还能一键拉回来就不叫退订）',
    !s.remote, `remote=${JSON.stringify(s.remote)}`);
  ok('退订后菜单里不再有同步/退订项',
    !s.menu.includes('同步这份清单') && !s.menu.includes('退订这份清单'),
    s.menu.join(' | '));
}

srv.close();
console.log('\n=== 汇总 ===');
const pass = results.filter(r => r.ok).length;
console.log(`  ${pass} 过 / ${results.length - pass} 失败`);
if (pass !== results.length) {
  console.log('\n失败项：');
  results.filter(r => !r.ok).forEach(r => console.log('  ✗ ' + r.n + (r.d ? '   — ' + r.d : '')));
}
ws.close();
process.exit(pass === results.length ? 0 : 1);
