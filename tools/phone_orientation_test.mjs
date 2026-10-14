#!/usr/bin/env node
/* ============================================================
   手机端「自动横屏」验证

   为什么单独写一份：
     电视端（device_test.mjs）走的是「硬锁 LANDSCAPE」分支，测试永远碰不到
     手机分支。而手机分支的关键取舍 —— SENSOR_LANDSCAPE 会压过系统旋转锁、
     但绝不退回竖屏 —— 只有真的把系统的自动旋转关掉、再往传感器里灌方向数据
     才能验出来。

   验证的 5 件事：
     1. 系统「自动旋转」关着并锁竖屏时，App 仍然横屏启动
     2. 自动旋转打开后把手机立起来（传感器=竖屏），App 不跟随
     3. 手机向左/向右倒，画面在两种横屏之间翻转（ROTATION_90 ↔ 270）
     4. 全程不重建 Activity（重建会打断直播重连）
     5. 全程不出现竖屏帧、不崩溃

   用法：
     node tools/phone_orientation_test.mjs
   前置：手机模拟器在线（默认 emulator-5556），已装 debug APK
   ============================================================ */
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5556';
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const PKG = 'com.ysptv.player';
const ACT = `${PKG}/.MainActivity`;

/* ---------- adb ---------- */
function adb(...a) {
  return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}
function adbRaw(...a) {
  return execFileSync(ADB, ['-s', SERIAL, ...a], { maxBuffer: 1 << 26 });
}
/** 模拟器控制台：往加速计里灌方向数据 */
function tilt(x, y, z) {
  try { adb('emu', 'sensor', 'set', 'acceleration', `${x}:${y}:${z}`); }
  catch (e) { console.error('  （传感器注入失败，请确认目标是模拟器）'); throw e; }
}

/* ---------- 读数 ---------- */
/** screencap 出的是物理帧缓冲，方向已应用 —— 宽>高就是横屏 */
function screenWH() {
  const b = adbRaw('exec-out', 'screencap', '-p');
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
/** 0/180=竖屏 90/270=两种横屏 */
function displayRotation() {
  const m = adb('shell', 'dumpsys', 'window', 'windows')
    .match(/mDisplayRotation=ROTATION_(\d+)/);
  return m ? +m[1] : null;
}
/** Activity 实例标识：方向切换若重建 Activity，这个哈希会变 */
function activityId() {
  const m = adb('shell', 'dumpsys', 'activity', 'activities')
    .match(new RegExp(`ActivityRecord\\{[0-9a-f]+ u0 ${PKG.replace(/\./g, '\\.')}/\\.MainActivity`));
  return m ? m[0] : null;
}
function strategyLog() {
  const logs = adb('shell', 'logcat', '-d', '-s', 'YSPTV:I');
  return (logs.match(/横屏策略: [^\n]*/) || [])[0] || '';
}
function launch() {
  adb('shell', 'am', 'force-stop', PKG);
  sleep(600);
  adb('shell', 'am', 'start', '-n', ACT);
}
function setRotation(accel, user) {
  adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', String(accel));
  adb('shell', 'settings', 'put', 'system', 'user_rotation', String(user));
}

/* ---------- 断言 ---------- */
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
  return ok;
}

/* ---------- 前置 ---------- */
adb('logcat', '-c');
console.log('设备:', SERIAL, '  screencap:', screenWH().join('x'), '\n');
const saved = {
  accel: adb('shell', 'settings', 'get', 'system', 'accelerometer_rotation') || '1',
  user: adb('shell', 'settings', 'get', 'system', 'user_rotation') || '0',
};

try {
  /* ============ 1. 最严苛场景：系统锁竖屏 + 冷启动 ============ */
  console.log('【1】系统「自动旋转」关闭并锁竖屏，冷启动 App');
  setRotation(0, 0);
  await sleep(600);
  adb('logcat', '-c');
  launch();
  await sleep(6000);

  console.log('  系统: accelerometer_rotation=0  user_rotation=0');
  let [w, h] = screenWH();
  check('App 强行横屏（系统锁竖屏也压得住）', w > h, `${w}x${h}`);
  check('走了手机分支（SENSOR_LANDSCAPE 而非电视硬锁）',
    /手机→SENSOR_LANDSCAPE/.test(strategyLog()), strategyLog() || '(未读到策略日志)');
  const idAfterLaunch = activityId();
  const idLockedPortrait = idAfterLaunch;
  check('Activity 实例标识可读', !!idAfterLaunch);

  /* ============ 2. 自动旋转打开，把手机立起来（传感器=竖屏） ============ */
  console.log('\n【2】打开系统自动旋转，传感器灌「竖屏」—— 期望：不跟随');
  setRotation(1, 0);
  tilt(0, 9.81, 0);
  await sleep(3000);
  [w, h] = screenWH();
  check('屏幕仍是横向（SENSOR_LANDSCAPE 拒绝竖屏）', w > h, `${w}x${h}`);
  check('没有旋转到竖屏方向', [0, 180].indexOf(displayRotation()) < 0,
    `mDisplayRotation=ROTATION_${displayRotation()}`);

  /* ============ 3. 左右翻转 ============ */
  console.log('\n【3】手机向左倒 / 向右倒 —— 期望：两种横屏之间翻转');
  const observed = [];
  for (const [x, label] of [[9.81, '向左倒'], [-9.81, '向右倒']]) {
    tilt(x, 0, 0);
    await sleep(3000);
    const r = displayRotation();
    observed.push(r);
    console.log(`  ${label} → ROTATION_${r}`);
  }
  check('两种横屏都到达过（左右翻转生效）',
    new Set(observed).size === 2 && observed.every(r => r === 90 || r === 270),
    observed.map(r => 'ROTATION_' + r).join(' / '));
  check('翻转过程中始终没有竖屏方向',
    observed.every(r => r === 90 || r === 270), '全为 90/270');

  /* ============ 4. 方向切换不重建 Activity ============ */
  console.log('\n【4】方向切换是否重建 Activity（重建会打断直播重连）');
  const idNow = activityId();
  check('Activity 实例未重建', !!idNow && idNow === idLockedPortrait,
    `${idLockedPortrait} → ${idNow}`);

  /* ============ 5. 后台 → 前台 ============ */
  console.log('\n【5】Home 回桌面再切回来');
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  await sleep(3000);
  adb('shell', 'am', 'start', '-n', ACT);
  await sleep(4000);
  [w, h] = screenWH();
  check('回到前台仍是横向', w > h, `${w}x${h}`);
  check('Activity 实例仍未重建', activityId() === idLockedPortrait);

  /* ============ 6. 稳定性 ============ */
  console.log('\n【6】稳定性');
  const fatal = (adb('shell', 'logcat', '-d') || '').split('\n')
    .filter(l => /FATAL EXCEPTION/.test(l));
  check('全程无崩溃', fatal.length === 0, `FATAL=${fatal.length}`);
} finally {
  // 还原系统旋转设置，别把模拟器留在奇怪的状态
  setRotation(saved.accel, saved.user);
  try { adb('emu', 'sensor', 'set', 'acceleration', '0:9.81:0'); } catch (e) { /* 非模拟器就算了 */ }
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
