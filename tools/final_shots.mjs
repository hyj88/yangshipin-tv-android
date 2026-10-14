#!/usr/bin/env node
/* 生成一组展示截图（模拟器实机）：默认态 → 换台 → 面板 → 卫视 */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const OUT = path.join(ROOT, 'dist', 'screenshots');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', maxBuffer: 1 << 24 }).trim();
const key = async (c, wait = 900) => { adb('shell', 'input', 'keyevent', String(c)); await sleep(wait); };
const shot = (n) => {
  const buf = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 });
  const p = path.join(OUT, n + '.png');
  writeFileSync(p, buf);
  console.log('  saved', n + '.png', buf.length, 'bytes');
  return p;
};

console.log('重启应用…');
adb('shell', 'am', 'force-stop', 'com.ysptv.player');
await sleep(1200);
adb('shell', 'am', 'start', '-n', 'com.ysptv.player/.MainActivity');
await sleep(11000);

console.log('抓图：');
shot('01_默认态_全屏直播');

await key(20);                                   // 下键换台
shot('02_换台_气泡提示');

await key(23, 1100);                             // 确认键弹出面板
shot('03_面板_左侧滑出');

await key(22, 3600);                             // 右键切卫视
shot('04_卫视页');

await key(20, 1100);                             // 面板内下移光标
await key(20, 1100);
shot('05_面板内移动光标');

adb('shell', 'input', 'keyevent', '4');          // 返回键收起面板（第一次不退出）
await sleep(1500);
shot('06_收起后恢复全屏');

console.log('\n输出目录:', OUT);
