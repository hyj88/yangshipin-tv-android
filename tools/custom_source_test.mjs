#!/usr/bin/env node
/* ============================================================
   「自定义源」功能验证

   三段：
     [静态]  资源齐不齐、清单注册对不对、版本号、minSdk
     [单测]  M3uParser / Source 在【宿主 JVM】上跑（不需要模拟器）
     [设备]  真机/模拟器上跑：起播、面板、按键、分组、管理浮层、局域网导入

   用法：
     node tools/custom_source_test.mjs              # 全跑（设备段需要 emulator-5554）
     node tools/custom_source_test.mjs static       # 只跑前两段（无需设备）
     ANDROID_SERIAL=emulator-5556 node tools/custom_source_test.mjs

   端口约定沿用已有脚本：9222 = TV(emulator-5554)
   目标页面按 url 里有没有 android_asset 来挑 —— 主界面和自定义源页在同一个
   进程里，两个 page target 会同时挂在同一个 devtools socket 上。
   ============================================================ */
import { execFileSync, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROJ = path.join(ROOT, 'yangshipin-tv');

/* Java 源码目录：从 AndroidManifest 的 package 推导，别写死。
   为什么：改包名（com.hyj.ysptv → com.ysptv.player）时，写死的路径会一次性全断 ——
   静态段直接报ENOENT 读不到 MainActivity.java，看起来像代码坏了，
   其实是路径写死的必然结果。staticChecks 与 hostUnitTests 都要用它，所以放模块级。 */
const MANIFEST_RAW = readFileSync(path.join(PROJ, 'app/src/main/AndroidManifest.xml'), 'utf8');
const GRADLE_RAW = readFileSync(path.join(PROJ, 'app/build.gradle'), 'utf8');
/* 包名从 build.gradle 的 namespace 读，不是从 AndroidManifest 的 package ——
   现代 AGP（7+）把 package 从 manifest 挪到了 namespace，
   manifest 里那个属性【根本不存在】，照着读会得到空串，
   于是 path.join 少拼一段目录，路径退化成 .../java/MainActivity.java → ENOENT。
   踩过：报错指向「代码坏了」，其实是取包名的地方取错了。 */
const PKG = (GRADLE_RAW.match(/namespace\s+['"]([^'"]+)['"]/) || [])[1] || '';
const JAVA_SRC = path.join(PROJ, 'app/src/main/java', PKG.replace(/\./g, '/'));
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`;
const SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
const PORT = process.env.PORT || '9222';
const CDP = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'dist', 'shots_custom');
const APK_DEBUG = path.join(PROJ, 'app/build/outputs/apk/debug/app-debug.apk');

const MODE = process.argv[2] || 'all';
const DELAY = 500;

/** 用户给的那份真实第三方聚合清单（best-fan/iptv-sources 的 cn_all.m3u8） */
const REAL_LIST = 'https://raw.githubusercontent.com/best-fan/iptv-sources/master/cn_all.m3u8';

mkdirSync(SHOTS, { recursive: true });

/* ---------- 断言 ---------- */
const results = [];
function check(name, cond, detail) {
  const ok = !!cond;
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
  return ok;
}
function section(t) { console.log(`\n=== ${t} ===`); }

/** 从提示条文案里抠出「上面/下面还有 N 项」的 N（抠不到给 -1，便于失败时一眼看出来） */
function hintNum(text, side) {
  const m = String(text || '').match(new RegExp(side + '面还有\\s*(\\d+)\\s*项'));
  return m ? +m[1] : -1;
}

function adb(...a) {
  return execFileSync(ADB, ['-s', SERIAL, ...a], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
}
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim(); }
  catch (e) { return (e.stdout || '') + (e.stderr || ''); }
}
/**
 * 应用自己的日志。CustomActivity.log() 全打到 logcat 的 YSPTV 标签上。
 * 镜像顺延的过程（「镜像顺延 2/3」）和收尾（「播放失败…（同台 3 路，本轮已试 3 路）」）
 * 只有这里看得到 —— 那个状态层是原生 TextView，不在 DOM 里，CDP 读不到。
 */
function logcat() {
  return sh(`"${ADB}" -s ${SERIAL} logcat -d -s YSPTV:V`);
}

/* ============================================================
   一、静态检查
   ============================================================ */
function staticChecks() {
  section('静态检查');

  check('AndroidManifest 里有 package（用于推导源码目录）', !!PKG, `package="${PKG}"`);
  check('build.gradle 的 namespace 读得到（用于推导源码目录）', !!PKG, `namespace="${PKG}"`);
  check('按 namespace 推导出的 Java 源码目录存在', existsSync(JAVA_SRC), JAVA_SRC);
  check('Java 文件都带 package 声明且与 namespace 一致（不一致编译不过）',
    readFileSync(path.join(JAVA_SRC, 'MainActivity.java'), 'utf8')
      .includes('package ' + PKG + ';'), `期望 package ${PKG};`);

  const assets = ['custom.html', 'custom.css', 'custom.js', 'inject.css', 'inject.js',
                  'lan_import.html'];
  for (const f of assets) {
    const p = path.join(PROJ, 'app/src/main/assets', f);
    check(`assets/${f} 存在且非空`, existsSync(p) && readFileSync(p, 'utf8').length > 200);
  }

  for (const f of ['Source.java', 'SourceStore.java', 'M3uParser.java',
                   'CustomActivity.java', 'LanImportServer.java', 'TvShellActivity.java']) {
    const p = path.join(JAVA_SRC, f);
    check(`java/${f} 存在`, existsSync(p));
  }

  const manifest = MANIFEST_RAW;
  check('清单注册了 CustomActivity', /android:name="\.CustomActivity"/.test(manifest));
  /* v1.9：桌面上只留一个图标。CustomActivity 刻意**不**注册任何桌面入口 ——
     用户反馈「安装会生成两个图标」，而这两个本来就是一件事的两面（自定义源是
     主界面里的一个面板）。所以这里反过来钉住「不许再有 leanback 入口」，
     免得哪天有人为了「方便」又把它加回去。 */
  const customBlock = (manifest.match(/android:name="\.CustomActivity"[\s\S]*?<\/activity>/) || [''])[0];
  check('CustomActivity 不再注册桌面入口（装完只有一个图标）',
    customBlock && !/intent-filter/.test(customBlock), customBlock.replace(/\s+/g, ' ').slice(0, 90));
  check('MainActivity 仍是唯一的 leanback 入口',
    /android:name="\.MainActivity"[\s\S]{0,900}LEANBACK_LAUNCHER/.test(manifest));
  check('两个 Activity 都锁 landscape',
    (manifest.match(/android:screenOrientation="landscape"/g) || []).length >= 2);
  check('两个 Activity 都声明了 orientation|screenSize configChanges',
    (manifest.match(/configChanges="orientation\|screenSize/g) || []).length >= 2);

  const gradle = readFileSync(path.join(PROJ, 'app/build.gradle'), 'utf8');
  /* ⚠️ 必须先剥掉行注释再解析。
     踩过：minSdk 那段注释里为了讲清来龙去脉写了「minSdk 三跳：19（1.4）→ 21（1.5）
     → 24（1.6）」，裸正则 `/minSdk\s+(\d+)/` 抓到的是注释里的 19，断言直接红给你看
     （好在是红、不是假绿）。和下面「setVideoURI 守卫那条要先剥注释」是同一个坑。 */
  const gradleCode = gradle.replace(/^\s*\/\/.*$/gm, '');
  const minSdk = +(gradleCode.match(/minSdk\s+(\d+)/) || [])[1];
  // minSdk 三跳：19（1.4 及以前，为 4.4 留门）→ 21（1.5，放弃 4.4，但还得留一页
  // 「内核能力体检」给 5.0/6.0）→ 24（1.6，老设备整体不伺候了，能力体检一并删除）。
  // 定在 24（Android 7.0）的理由：央视频要 MSE + WebAssembly + fetch，最低 **Chrome 57**
  // （2017 年）；7.0 起 WebView 是独立可更新 APK，在役设备的内核都远高于 57，
  // 而 5.0/6.0 那批是「装得上、内核可能还停在 Chromium 37」—— 不为它们养降级路径了。
  check('minSdk = 24（Android 7.0；1.6 起老设备整体不伺候）', minSdk === 24, `minSdk=${minSdk}`);
  check('零第三方依赖', /dependencies\s*\{\s*\}/.test(gradle));
  // ⚠️ 提到 24 **不等于** API 隔离可以删：24 < 28 < 30，Api28 / Api30 必须留着。
  //    这两个类是「minSdk 24 的设备加载 API 30 类型会不会崩」的唯一防线。
  for (const iso of ['Api28.java', 'Api30.java']) {
    check(`${iso} 隔离类仍在（minSdk 24 < 28 < 30，删了会在 7.0 上 NoClassDefFoundError）`,
      existsSync(path.join(JAVA_SRC, iso)));
  }
  // 能力体检整条路径必须真的没了（留一半就是死代码）
  const mainAct2 = readFileSync(path.join(JAVA_SRC, 'MainActivity.java'), 'utf8');
  check('MainActivity 已删掉内核能力体检（1.6 起 7.0 以下装不上，不再给提示）',
    !/checkBrowserCapability|showCapabilityError|onCapability|capabilityChecked|capabilityFailed/
      .test(mainAct2));

  // 自定义页面必须【不要】造 .tv-main-con-l —— 那是个不透明全屏层，会把视频盖掉
  // （注释里提到它没关系，所以先把 HTML 注释剥掉再查）
  const htmlRaw = readFileSync(path.join(PROJ, 'app/src/main/assets/custom.html'), 'utf8');
  const html = htmlRaw.replace(/<!--[\s\S]*?-->/g, '');
  check('custom.html 不含 .tv-main-con-l 元素（否则不透明层会盖住原生视频）',
    !/tv-main-con-l/.test(html));
  const css = readFileSync(path.join(PROJ, 'app/src/main/assets/custom.css'), 'utf8');
  check('custom.css 把 html/body 背景改透明', /html,\s*body\s*\{[\s\S]{0,80}transparent/.test(css));
  check('custom.css 管理浮层用 display:none 摘掉面板',
    /ysp-managing[\s\S]{0,120}display:\s*none/.test(css));

  const js = readFileSync(path.join(PROJ, 'app/src/main/assets/custom.js'), 'utf8');
  check('custom.js 装了 tab 探针 __yspTV_TAB_PROBE', /__yspTV_TAB_PROBE\s*=/.test(js));
  check('custom.js 的 bridge 按实参个数转发（JavaBridge 是精确匹配）',
    /var n = arguments\.length/.test(js));

  const injectJs = readFileSync(path.join(PROJ, 'app/src/main/assets/inject.js'), 'utf8');
  check('inject.js 里留了 tab 探针位', /__yspTV_TAB_PROBE/.test(injectJs));
  check('assets/inject.js 与 tools/inject.js 同步',
    injectJs === readFileSync(path.join(ROOT, 'tools/inject.js'), 'utf8'));
  check('assets/inject.css 与 tools/inject.css 同步',
    readFileSync(path.join(PROJ, 'app/src/main/assets/inject.css'), 'utf8')
    === readFileSync(path.join(ROOT, 'tools/inject.css'), 'utf8'));

  /* ---------- 1.5.1：选台面板顶部那个【看得见的】「自定义源」入口 ----------
     起因：Google TV 的桌面会把同一包名的多个 LEANBACK_LAUNCHER 入口按包聚合成
     一张卡片，桌面那张「自定义源」卡片根本不出现；蓝键 / 长按菜单键又都是隐藏
     操作。功能一直是好的，缺的只是一个打开面板就看得见的入口。
     这几条盯的是「入口不会反过来把频道列表搞坏」—— 那是最容易踩的坑。 */
  check('inject.js 会在面板上挂出 #ysp-custom-entry',
    /ENTRY_ID\s*=\s*'ysp-custom-entry'/.test(injectJs));
  // 自定义源页自己也复用 inject.js（custom.html 故意造出一样的 DOM 形状）：
  // 1.5.1 时那边【不】挂入口（动作是开 CustomActivity，挂上就是自指，且没有 yspBridge）；
  // 1.8 起挂的是「＋ 添加自定义源」，动作换成打开本页源管理，就不再是自指了
  check('入口按桥区分两种页面/两种动作（自定义源页是「添加」变体）',
    /function entryWanted\(\)[\s\S]{0,300}yspBridge\.openCustom/.test(injectJs)
    && /ENTRY_TEXT_ADD/.test(injectJs)
    && /function entryIsAdd\(\)/.test(injectJs));
  check('入口插在频道列表【之外】（否则会被 rows()/count 当成第 0 个频道）',
    /insertBefore\(el, list\)/.test(injectJs));
  // 不能写成 idx+d<0，也不能只写 d<0 —— move(-99)/move(-9999) 这种大跨度回顶都会被
  // 当成「到顶了又按一次上」，光标粘在入口上下不来（custom.js 的 resetCursor(toTop)
  // 正是用 move(-9999) 回顶的；自定义源页挂了入口之后这就是天天踩的路径）
  check('只有「已在第 0 台、再按一次【单步】上」才进入口（大跨度回顶不受影响）',
    /d === -1 && idx === 0 && entryEl\(\)/.test(injectJs));
  check('光标在入口上时，paint() 不动画面列表 / 不动画面滚动',
    /if \(onEntry\)[\s\S]{0,200}classList\.add\(FOCUS\); return;/.test(injectJs));
  /* ⚠️ 这两条是踩出来的，不是设计出来的 —— 删掉任何一条，App 会「看起来崩了」：
       DOMTokenList.remove() 按规范无条件走 update steps，就算 class 本来不在也会
       把 class 属性重写一遍 → 每次 clearFocus 给 40 行各记一条变更 → 观察者触发
       重画 → 又重写 40 行 … 平时没事（重画完会给光标行 add 回去，观察者看到有焦点
       就停），但光标停在入口上时频道行【永远没有焦点】，循环停不下来：
       渲染进程 107% CPU 空转、CDP 永不回包，现象和「App 崩了」一模一样。 */
  check('clearFocus 先判断再摘（否则会陷入 paint↔观察者 无限重画）',
    /if \(r\.classList\.contains\(FOCUS\)\) r\.classList\.remove\(FOCUS\)/.test(injectJs));
  check('观察者对「光标在入口上」直接放行（第二道防线）',
    /new MutationObserver\(function \(\) \{[\s\S]{0,300}if \(onEntry\) return;/.test(injectJs));

  const injectCss = readFileSync(path.join(PROJ, 'app/src/main/assets/inject.css'), 'utf8');
  check('入口不参与列表滚动（flex:0 0 auto，永远可见）',
    /#ysp-custom-entry[\s\S]{0,240}flex:\s*0 0 auto/.test(injectCss));
  check('入口有光标态 .ysp-focus（和频道行一套视觉语言）',
    /#ysp-custom-entry\.ysp-focus/.test(injectCss));
  const mainAct = readFileSync(path.join(JAVA_SRC, 'MainActivity.java'), 'utf8');
  check('MainActivity 的 JS 桥暴露 openCustom()（页面靠它开自定义源）',
    /JavascriptInterface[\s\S]{0,300}public void openCustom\(\)/.test(mainAct));
  check('openCustom() 走主线程（桥方法跑在 JavaBridge 线程，不能直接 startActivity）',
    /public void openCustom\(\)[\s\S]{0,200}ui\.post/.test(mainAct));

  // 局域网导入服务不该顺手暴露别的东西
  const lan = readFileSync(path.join(JAVA_SRC, 'LanImportServer.java'), 'utf8');
  check('局域网服务只绑 0.0.0.0 的随机端口（不常驻）', /bind\(new InetSocketAddress\("0\.0\.0\.0", 0\)\)/.test(lan));
  check('局域网服务有 body 上限', /MAX_BODY/.test(lan));

  /* ---------- 「从网址导入」这一版（1.3）新增的东西 ---------- */
  const JAVA_DIR = JAVA_SRC;
  for (const f of ['PlaylistFetcher.java', 'SourceImport.java']) {
    check(`java/${f} 存在`, existsSync(path.join(JAVA_DIR, f)));
  }

  const pf = readFileSync(path.join(JAVA_DIR, 'PlaylistFetcher.java'), 'utf8');
  // 零 Android 依赖是硬要求：它和 M3uParser 一起在宿主 JVM 上跑单测，
  // 一旦有人往里加一句 android.util.Log，单测就编不过（这是刻意设计的护栏）
  check('PlaylistFetcher 零 Android 依赖（否则宿主单测编不过）', !/import android\./.test(pf));
  check('PlaylistFetcher 自己跟重定向（关掉默认实现，才能拿到跳转链）',
    /setInstanceFollowRedirects\(false\)/.test(pf));
  check('PlaylistFetcher 明确声明 Accept-Encoding: identity', /"Accept-Encoding",\s*"identity"/.test(pf));
  check('PlaylistFetcher 有正文上限（不许把任意大文件读进内存）',
    /MAX_BYTES\s*=\s*\d+\s*\*\s*1024\s*\*\s*1024/.test(pf));
  check('PlaylistFetcher 用 gzip 魔数嗅探，而不是只信 Content-Encoding',
    /0x1f/.test(pf) && /GZIPInputStream/.test(pf));
  check('PlaylistFetcher 会嗅探 GBK（中文清单常有）', /GBK/.test(pf) && /strictDecode/.test(pf));
  check('PlaylistFetcher 失败时就地记错（不新造对象，保住 status/finalUrl）',
    /Result err\(String why\)/.test(pf));
  check('PlaylistFetcher 只放行 http/https（不能被当通用代理用）', /M3uParser\.isStreamUrl/.test(pf));

  const si = readFileSync(path.join(JAVA_DIR, 'SourceImport.java'), 'utf8');
  check('SourceImport 抓不到清单时也把地址当单条源收下（保住老行为）',
    /single\(r,\s*name,\s*u/.test(si));
  check('SourceImport 成功抓到清单才记住地址', /saveRemoteUrl\(app,\s*r\.listUrl\)/.test(si));

  check('局域网服务有 /api/addurl 路由', /"\/api\/addurl"\.equals\(path\)/.test(lan));
  check('局域网服务有 /api/refresh 路由', /"\/api\/refresh"\.equals\(path\)/.test(lan));
  // ⚠️ 匹配的是 Java 源码里转义之后的形态（\"remote\":），不是 JSON 里的 "remote":
  check('/api/list 会回报记住的清单地址', lan.includes('\\"remote\\":'), 'listJson 里没找到 remote 字段');

  const store = readFileSync(path.join(JAVA_DIR, 'SourceStore.java'), 'utf8');
  check('SourceStore 记住清单地址（K_REMOTE）', /K_REMOTE/.test(store));
  // 「清空全部源」不能把清单地址一起清掉 —— 否则「清空 → 一键拉回来」这条恢复路就断了
  const clearBody = (store.match(/static void clear\(Context c\) \{[\s\S]*?\n    \}/) || [''])[0];
  check('clear() 不删清单地址（留着一键重新导入）',
    clearBody.length > 0 && !/K_REMOTE/.test(clearBody), clearBody ? '' : '没找到 clear 方法体');

  const lanPage = readFileSync(path.join(PROJ, 'app/src/main/assets/lan_import.html'), 'utf8');
  check('导入页有「从网址导入」输入框', /id="rurl"/.test(lanPage));
  check('导入页的按钮分别打 /api/addurl 与 /api/refresh',
    /\/api\/addurl/.test(lanPage) && /\/api\/refresh/.test(lanPage));
  check('导入页会显示「已记住的清单地址」', /id="rmem"/.test(lanPage) && /\.remote/.test(lanPage));
  check('导入页仍然零外部资源（电视可能出不了公网）',
    !/<(script|link)[^>]+(src|href)="https?:/i.test(lanPage));

  check('custom.js 有 setRemote（菜单据此决定出不出刷新项）', /function setRemote/.test(js));
  check('custom.js 的刷新菜单项接了 bridge("refresh")', /bridge\('refresh'\)/.test(js));
  // 菜单比卡片高时必须跟着光标滚（否则高亮行跑到卡片外，用户看不见自己选到哪）
  check('custom.js 的菜单列表会跟着光标滚（scrollMenuIntoView）',
    /function scrollMenuIntoView/.test(js) && /scrollMenuIntoView\(\);/.test(js));
  // 只滚还不够：滚动条是关掉的，得有一条「下面还有 N 项」的文字提示，
  // 否则用户看到的就是「菜单只有 4 项」，不会想到还要往下按
  {
    const css = readFileSync(path.join(PROJ, 'app/src/main/assets/custom.css'), 'utf8');
    check('custom.js 有「还有多少项」的提示（updateMenuMore）',
      /function updateMenuMore/.test(js) && /updateMenuMore\(\);/.test(js));
    check('custom.css 有 .mg-more 样式，且默认不显示',
      /\.mg-more\s*\{/.test(css) && /\.mg-more\s*\{[^}]*display:\s*none/.test(css));
    check('custom.css 有列表边缘淡出的三种组合（cut-top/cut-bot/cut-both）',
      /\.mg-list\.cut-bot\s*\{/.test(css) && /\.mg-list\.cut-top\s*\{/.test(css)
      && /\.mg-list\.cut-both\s*\{/.test(css));
  }
  /* ---------- 镜像自动顺延（1.4）新增的东西 ---------- */
  check('java/Mirrors.java 存在', existsSync(path.join(JAVA_DIR, 'Mirrors.java')));
  const mir = readFileSync(path.join(JAVA_DIR, 'Mirrors.java'), 'utf8');
  check('Mirrors 零 Android 依赖（要和 M3uParser 一起在宿主 JVM 上跑单测）',
    !/import android\./.test(mir));
  // ⚠️ 下面几条是「归一化不许合错」的静态护栏。真正的行为验证在 MirrorsTest 里，
  //    这里只保证关键规则没被后来的人顺手「优化」掉 —— 合错了的后果是点 A 播出 B。
  {
    const sepInit = (mir.match(/SEPARATORS\s*=\s*([\s\S]*?);/) || [])[1] || '';
    check('Mirrors 的分隔符白名单不含 + 和 &（CCTV5 与 CCTV5+ 是两个台）',
      sepInit.length > 0 && !/[+&]/.test(sepInit),
      sepInit ? sepInit.trim().replace(/\s+/g, ' ').slice(0, 70) : '没找到 SEPARATORS');
  }
  check('Mirrors 用 Locale.ROOT 转小写（默认 locale 在土耳其语环境下会算错）',
    /toLowerCase\(Locale\.ROOT\)/.test(mir));
  check('Mirrors 用 NFKC 归一（全角 → 半角）', /Normalizer\.Form\.NFKC/.test(mir));
  check('Mirrors 对无台名的源直接放弃分组（否则匿名源会互相顺延）',
    /if \(k\.isEmpty\(\)\) return null/.test(mir));
  check('Mirrors 的画质标签剥离不贪心（有次数上限，不会把台名啃光）',
    /for \(int i = 0; i < 3; i\+\+\)/.test(mir));

  // ── Locale 陷阱：Mirrors 防住了，解析层和抓取层也得防住 ──────────────
  // 土耳其语 locale 下 "I".toLowerCase() == "ı"（无点 i），
  // 于是 "#EXTINF".toUpperCase() 变成 "#EXTİNF"，整份清单的指令行全部匹配不上 →
  // 解析出 0 条。Mirrors 里专门做了防护，别的文件不能漏。
  {
    const mp = readFileSync(path.join(JAVA_DIR, 'M3uParser.java'), 'utf8');
    const bare = [...mp.matchAll(/\.(toUpperCase|toLowerCase)\(\)/g)];
    check('M3uParser 里的大小写转换都带 Locale.ROOT（否则土耳其语环境下整份清单解析出 0 条）',
      bare.length === 0, bare.length ? `还有 ${bare.length} 处裸转换` : '已全部带 Locale.ROOT');
  }
  // MainActivity 里那个「每 15 秒自我重排」的补注入任务，只要页面加载成功过一次就永远续命。
  // onDestroy 不清回调 = Activity 连同 WebView 一直泄漏到进程被杀。
  {
    const ma = readFileSync(path.join(JAVA_DIR, 'MainActivity.java'), 'utf8');
    const d0 = ma.indexOf('protected void onDestroy()');
    const d1 = ma.indexOf('protected void onSaveInstanceState');
    const body = (d0 >= 0 && d1 > d0) ? ma.slice(d0, d1) : '';
    check('MainActivity.onDestroy 清掉排队的回调（那个 15 秒自我重排的任务会一直泄漏）',
      body.length > 0 && /removeCallbacksAndMessages\(null\)/.test(body),
      body ? '' : '没找到 onDestroy 方法体');
  }

  const caSrc = readFileSync(path.join(JAVA_DIR, 'CustomActivity.java'), 'utf8');
  /* v1.9：从剪贴板导入。电视上没有「粘贴」这个动作，屏上键盘敲六七十个字符的
     清单网址不现实，所以剪贴板是唯一顺手的路。这三条盯的是「桥真的存在、
     读剪贴板回主线程、拿到的是 ClipboardManager 而不是别的东西」——
     少了 ui.post 就是在线程外摸系统服务，少了 escape 就是剪贴板里有引号换行时
     整段 JS 语法错误（而且报错信息没人看得懂）。 */
  check('CustomActivity 暴露 clip() 桥（电视端唯一的「粘」法）',
    /JavascriptInterface[\s\S]{0,200}public void clip\(\)/.test(caSrc));
  check('读剪贴板回主线程（桥方法跑在 JavaBridge 线程上）',
    /public void clip\(\)[\s\S]{0,400}ui\.post/.test(caSrc));
  check('剪贴板内容用 JSONObject.quote 转义后再拼进 JS（里面有引号/换行/&）',
    /JSONObject\.quote\(t\)/.test(caSrc));
  check('clipboard 读的是系统 ClipboardManager 的 primaryClip',
    /getSystemService\(android\.content\.Context\.CLIPBOARD_SERVICE\)/.test(caSrc)
    && /getPrimaryClip\(\)/.test(caSrc));
  check('剪贴板里的多行清单走 addText → SourceImport.importText',
    /public void addText\(final String text\)/.test(caSrc)
    && /imp\.importText\(text, null\)/.test(caSrc));
  check('v1.9：不再有内置示例源（seeds 桥与 ensureSeeded 都删了）',
    !/SourceStore\.seeds\(\)/.test(caSrc) && !/ensureSeeded/.test(caSrc));
  check('SourceStore 里也删干净了 seeds/ensureSeeded',
    !/static List<Source> seeds\(\)/.test(
      readFileSync(path.join(JAVA_DIR, 'SourceStore.java'), 'utf8')));
  // v1.9 踩到的真bug：零源提示（原生状态层）与源管理浮层同屏 → 文字直接叠在一起
  //（浮层占左半屏、状态层居中，正好压住菜单右侧的 tail 文案）。
  // 修法是「提示文案存起来，浮层开关时重判显不显示」，这两条断言守住那个机制。
  check('零源提示独立成 showZeroHint（不再直接 showStatus）',
    /private void showZeroHint\(\)/.test(caSrc)
    && !/showStatus\("还没有源"/.test(caSrc));
  check('浮层开关会重判零源提示的显隐（applyZeroHintVisibility，!manageOpen 才显示）',
    /private void applyZeroHintVisibility\(\)/.test(caSrc)
    && /boolean show = !manageOpen/.test(caSrc)
    && /manage\(final boolean open\)[\s\S]{0,160}applyZeroHintVisibility\(\)/.test(caSrc));
  check('showStatus/hideStatus 会清掉 zeroHint（换状态后老提示不该复活）',
    /zeroHint = null/.test(caSrc));
  // ---- v1.11：订阅的同步删除与退订 ----
  const ssSrc = readFileSync(path.join(JAVA_DIR, 'SourceStore.java'), 'utf8');
  const siSrc = readFileSync(path.join(JAVA_DIR, 'SourceImport.java'), 'utf8');
  const srcSrc = readFileSync(path.join(JAVA_DIR, 'Source.java'), 'utf8');
  check('Source 有 from 字段（哪条来自哪份清单 —— 退订/同步的地基）',
    /String from;/.test(srcSrc) && /fromList\(String listUrl\)/.test(srcSrc));
  check('存储格式写成键 "f"，且只在有值时写（省体积）',
    /o\.put\("f", s\.from\)/.test(ssSrc) && /o\.optString\("f", null\)/.test(ssSrc));
  // ⚠️ 这条守的是最贵的边界：同步只能删「from == 这份清单」的那些。
  //    越界一次就是误删用户的真台，而这行代码删起来毫不显眼。
  check('同步只删 from == 本清单的（手加的、别家的一律不碰）',
    /s\.fromList\(listUrl\) && !inList\.contains\(s\.url\)/.test(ssSrc));
  check('退订只删 from == 本清单的',
    /if \(s\.fromList\(listUrl\)\)/.test(ssSrc));
  check('退订会把清单地址一起清掉（留着还能一键拉回来就不叫退订）',
    /clearRemoteUrl\(app\)/.test(siSrc) && /static void clearRemoteUrl/.test(ssSrc));
  check('清空全部源【仍然】保留清单地址（与退订刻意相反）',
    /static void clear\(Context c\)/.test(ssSrc)
    && /remove\(K_LIST\)\.remove\(K_CUR\)/.test(ssSrc)
    && !/static void clear\(Context c\)[\s\S]{0,400}remove\(K_REMOTE\)/.test(ssSrc));
  // ⚠️ 只在 refreshRemote 的方法体里判「没有 merge」——
  //    拿整个文件去搜会误伤 importUrl（它本来就该用 merge + 标记来源）。
  const refreshBody = (siSrc.match(/Result refreshRemote\(\) \{([\s\S]*?)\n    \}/) || ['', ''])[1];
  check('刷新走 syncFrom（同步删除）而不是 merge（只增不减）',
    /SourceStore\.syncFrom\(app, parsed, r\.listUrl\)/.test(siSrc)
    && refreshBody.length > 0
    && !/SourceStore\.merge\(/.test(refreshBody),
    refreshBody ? (refreshBody.match(/SourceStore\.\w+\(/g) || []).join(' ') : '没匹配到 refreshRemote');
  check('importUrl 给条目打上来源标记（不然退订无从下手）',
    /SourceStore\.merge\(app, tagFrom\(parsed, r\.listUrl\)\)/.test(siSrc));
  check('正在播的那条被删了会自动换台（不换的话播放器会一直抱着死地址）',
    /r\.playingRemoved\) switchToFirstAvailable\(\)/.test(caSrc)
    && /private void switchToFirstAvailable\(\)/.test(caSrc));
  check('同步的提示把「加了几条/删了几条」都说清楚',
    /清单已更新/.test(siSrc) && /上游已下架或改名/.test(siSrc));
  check('custom.js 菜单有「退订这份清单」，且武装状态和 clearArm 分开',
    /label: unlistArm \? '再按一次确认退订' : '退订这份清单'/.test(js)
    && /var unlistArm = false;/.test(js));
  check('「刷新远程清单」改名为「同步这份清单」（文案要说实话：它现在真的会删）',
    /label: '同步这份清单'/.test(js));

  // ---- v1.10：手机上手指点菜单项（用户反馈「点从剪贴板导入/屏上输入没反应」）----
  check('菜单项带 data-i（点击委托靠它反查是哪一项）',
    /r\.setAttribute\('data-i', String\(i\)\)/.test(js));
  check('浮层绑了点击（click + 触摸设备的 pointerdown）',
    /elMg\.addEventListener\('click', onManagePointer/.test(js)
    && /pointerdown'[\s\S]{0,120}pointerType === 'touch'[\s\S]{0,80}onManagePointer/.test(js));
  check('点击语义是「跳到那一项并立刻执行」（不是先选中再按确认）',
    /function onMenuClick[\s\S]{0,900}runMenu\(\)/.test(js)
    && /mgIdx = i;/.test(js));
  // ⚠️ 这条守的是一个真踩过的坑：onKbClick 里曾用 `var key = ...closest('.kb-key')`，
  //    把同名的 function key(name) 遮蔽掉，于是 key('OK') 变成「拿元素当函数调」，
  //    TypeError 被 WebView 吞掉 —— 菜单点击照常工作，只有键盘完全失灵，
  //    而日志里什么都看不到。局部变量一旦和函数重名必须一眼能看出来。
  //精确取出 onKbClick 的函数体再判，别用跨函数的宽松正则（那会连着别的函数一起匹配）
  const kbClickBody = (js.match(/function onKbClick\(e\) \{([\s\S]*?)\n  \}/) || ['', ''])[1];
  check('onKbClick 里的局部变量不叫 key（别遮蔽同名的 function key(name)）',
    /function onKbClick\(e\) \{/.test(js)
    && /var keyEl = /.test(kbClickBody)
    // ⚠️ 只查【代码行】：函数体里那段注释本身就写着「var key = ...」，
    //    直接在整段文字里搜 var key 一定会命中，守卫就成了永远红的死条文。
    && !/^\s*var key\b/m.test(kbClickBody),
    kbClickBody ? kbClickBody.split('\n')[0].trim() : '没匹配到 onKbClick');
  check('键盘键带 data-r/data-c（手机上靠它反查按了哪个键）',
    /keyEl\.setAttribute\('data-r', String\(r\)\)/.test(js)
    && /keyEl\.setAttribute\('data-c', String\(c\)\)/.test(js));
  check('一次触摸只算一次（pointerdown 之后的 click 被丢掉，两段式确认才成立）',
    /pendingClick/.test(js) && /byPointer/.test(js));
  check('清空的武装状态只在换项时解除（点同一项要保留，否则永远清不掉）',
    /if \(it\.id !== 'clear'\) clearArm = false;/.test(js)
    && !/onMenuClick[\s\S]{0,400}?clearArm = false;\s*\n\s*buildMenu/.test(js));
  const css19 = readFileSync(path.join(PROJ, 'app/src/main/assets/custom.css'), 'utf8');
  check('浮层开了 touch-action: manipulation（否则触屏 click 迟到/被缩放手势吃掉）',
    /#ysp-manage[\s\S]{0,200}touch-action: manipulation/.test(css19));
  check('.mg-list 开了 touch-action: pan-y（手机上菜单要能滑到后面的项）',
    /\.mg-list[\s\S]{0,300}touch-action: pan-y/.test(css19));
  check('触摸设备有专门布局：卡片放大 + 头部压扁 + 按下反馈',
    /@media \(hover: none\)/.test(css19)
    && /@media \(hover: none\)[\s\S]{0,600}\.mg-item:active/.test(css19));

  check('custom.js 的 clipResult 按「单行网址 / 多行文本」分派',
    /function clipResult\(text\)/.test(js)
    && /bridge\('add', ''/.test(js) && /bridge\('addText', t\)/.test(js));
  check('custom.js 菜单里有「从剪贴板导入」且没有「恢复内置示例源」',
    /id: 'clip', label: '从剪贴板导入'/.test(js)
    && !/恢复内置示例源/.test(js));

  check('CustomActivity 的失败收口接了镜像顺延（failWith 里调 Mirrors.next）',
    /Mirrors\.next\(sources/.test(caSrc));
  check('顺延带了路数上限与总时长预算两个停止条件',
    /mirrorTried\.size\(\) < Mirrors\.MAX_ATTEMPTS/.test(caSrc)
    && /Mirrors\.WALK_BUDGET_MS/.test(caSrc));
  check('顺延用世代号防「延迟任务把用户刚选的台拽回去」',
    /playGen\+\+/.test(caSrc) && /playGen != gen/.test(caSrc));
  check('推进延迟出去（不许在 MediaPlayer 的 onError 回调里重入 stopPlayback）',
    /ui\.postDelayed\(new Runnable\(\)[\s\S]{0,400}play\(go, false\)/.test(caSrc));
  // 用户打开源管理浮层时不顺延（那是「我要接管」的信号），而且必须留日志 ——
  // 第一次跑设备端用例就是被这条规则挡掉的，当时一声不吭，看着像功能没写。
  {
    const f0 = caSrc.indexOf('private void failWith(String why)');
    const f1 = caSrc.indexOf('// =====================================================================', f0);
    const fw = (f0 >= 0 && f1 > f0) ? caSrc.slice(f0, f1) : '';
    check('用户打开源管理浮层时不顺延，且会留一条可排障的日志',
      fw.length > 0 && /if \(manageOpen\)/.test(fw) && /跳过镜像顺延/.test(fw),
      fw ? '' : '没找到 failWith 方法体');
    // ⚠️⚠️ 下面这条钉的是一个 **修掉的真 bug**，而且它说明了一类断言怎么写才有用。
    //    上一版的断言是「onPrepared 里必须有 mirrorWalkStart = now()」，
    //    而那正是 bug 本身：预算于是从「出画那一刻」起算，用户看满十分钟再断流时
    //    now - start 已经十几分钟，远超 40 秒 → 一路都不试，直接报「无法播放」。
    //    断言钉住了实现细节、却钉错了语义 —— 于是「全绿」和「功能是坏的」同时成立。
    //    改成钉正确语义：预算在 failWith 里、且只在**这一串的第一次失败**时起算。
    check('顺延的时间预算从【这一串的第一次失败】起算（不是起播成功，也不是每次失败都重置）',
      /if \(!mirroring\) \{[\s\S]{0,240}mirroring = true;[\s\S]{0,240}mirrorWalkStart = System\.currentTimeMillis\(\)/.test(fw),
      fw ? '' : '没找到 failWith 方法体');
  }
  // ⚠️ 下面两条钉的是两个【反直觉】的决定，很容易被当成冗余代码删掉：
  {
    const i0 = caSrc.indexOf('onPrepared(android.media.MediaPlayer mp)');
    const i1 = caSrc.indexOf('setOnErrorListener');
    const prep = (i0 >= 0 && i1 > i0) ? caSrc.slice(i0, i1) : '';
    check('起播成功时【不】清空 mirrorTried（清了会在同族镜像之间来回弹）',
      prep.length > 0 && !/mirrorTried\.clear\(\)/.test(prep),
      prep ? '' : '没找到 onPrepared 方法体');
    // ⚠️ 这里是上面那条预算断言的另一半：起播成功只【结束】这一串失败（mirroring=false），
    //    **不能**在这里给 mirrorWalkStart 重新赋值 —— 见 failWith 那条断言的长注释。
    check('起播成功时【不】给预算重新计时（那样预算永远从出画那一刻算起）',
      prep.length > 0 && !/mirrorWalkStart = System\.currentTimeMillis\(\)/.test(prep),
      prep ? '' : '没找到 onPrepared 方法体');
    check('起播成功时把「这一串失败」标记为结束（下一次失败重新起算预算）',
      /mirroring = false/.test(prep));
  }
  // ── 生命周期：延迟任务必须在退出/切后台时清掉 ──────────────────────────
  // 起播看门狗（15s）和镜像顺延（250ms）都是 postDelayed 的。不清的话：
  //   用户按 HOME 或连按两次返回退出之后，任务照跑 → failWith → 顺延 → video.start()，
  //   表现是「退出之后电视自己响」，而且没有 Surface，有声无画，只能杀进程。
  {
    const p0 = caSrc.indexOf('protected void onPause()');
    const p1 = caSrc.indexOf('protected void onDestroy()');
    const d1 = caSrc.indexOf('protected void onDestroy()');
    const d2 = caSrc.indexOf('// =====================================================================', d1);
    const pu = (p0 >= 0 && p1 > p0) ? caSrc.slice(p0, p1) : '';
    const ds = (d1 >= 0 && d2 > d1) ? caSrc.slice(d1, d2) : '';
    check('onPause 清掉排队的回调（否则切后台后看门狗会在后台把下一路拉起来）',
      pu.length > 0 && /removeCallbacksAndMessages\(null\)/.test(pu), pu ? '' : '没找到 onPause 方法体');
    check('onDestroy 清掉排队的回调（否则退出之后电视会自己响）',
      ds.length > 0 && /removeCallbacksAndMessages\(null\)/.test(ds), ds ? '' : '没找到 onDestroy 方法体');
    // ⚠️ `if (video.isPlaying()) video.pause()` 是个陷阱：缓冲中 isPlaying() 是 false，
    //    pause() 于是不被调用，而 mTargetState 只在 pause() 里才设成 PAUSED，
    //    结果 prepared 一到就自己 start() —— 缓冲中切后台 = 后台自动播放。
    // ⚠️ 匹配前必须先把注释行剥掉：源码注释里把这句当反面例子写了一遍，
    //    不剥就会匹配到注释、断言永远为真（我第一版就是这个错，白写一条断言）。
    const puCode = pu.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check('onPause 无条件 pause（不能只在 isPlaying() 时才 pause）',
      pu.length > 0 && !/isPlaying\(\)\s*\)\s*video\.pause\(\)/.test(puCode)
      && /video\.pause\(\)/.test(puCode), pu ? '' : '没找到 onPause 方法体');
  }
  // setVideoURI(Uri, Map) 是 API 21 才有的。minSdk 还是 19 时必须加
  // `SDK_INT < LOLLIPOP` 守卫退回无头版本，否则 4.4 上 NoSuchMethodError。
  // 1.5 起 minSdk = 21，守卫连同「少个 Referer 就 403」的那批机器一起消失：
  // 现在所有设备都能带请求头。这条断言把「守卫确实删了」钉住，防止以后误加回来。
  // ⚠️ 匹配前剥掉注释 —— 源码注释里把 `SDK_INT < LOLLIPOP` 当历史写了一遍，
  //    不剥会匹配到注释、断言永远为真。
  {
    const caCode = caSrc.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check('带请求头的 setVideoURI 已去掉 API 21 守卫（minSdk 21 已覆盖）',
      !/SDK_INT < Build\.VERSION_CODES\.LOLLIPOP/.test(caCode)
      && /setVideoURI\(u, h\)/.test(caCode)
      && /setVideoURI\(u\)/.test(caCode));
  }
  // 顺延换过来时【不能】用「正在连接…」盖掉上一条失败说明 —— 推进只隔 250ms，
  // 盖掉就等于那三行说明（哪一路不通 / 为什么 / 按菜单键换台）从没出现过。
  // 这一条是写截图脚本时才发现的：只有真去看「用户在那 250ms 里看到什么」才会注意到。
  // 它和 onCompletion 无关，所以【不放进】下面那个只圈方法体的块里。
  check('顺延换过来时不盖掉失败说明（否则说明只闪 250ms）',
    /if \(!mirrorHop\) \{[\s\S]{0,240}showStatus\("正在连接…"/.test(caSrc)
    && /nextPlayIsHop = true/.test(caSrc));
  // 点播播完不是失败。把它接到 failWith 上会导致「看完一集自动去试别的台」。
  {
    const j0 = caSrc.indexOf('setOnCompletionListener');
    const j1 = caSrc.indexOf('setOnInfoListener');
    const comp = (j0 >= 0 && j1 > j0) ? caSrc.slice(j0, j1) : '';
    check('点播播完（onCompletion）不触发镜像顺延',
        comp.length > 0 && !/failWith/.test(comp), comp ? '' : '没找到 onCompletion 方法体');
  }

  check('custom.js 菜单项顺序：刷新项在「屏上输入新源」之后（下标不能乱）',
    js.indexOf("label: '屏上输入新源'") > 0
    && js.indexOf("label: '屏上输入新源'") < js.indexOf("label: '同步这份清单'"));

  /* ---- 「调用了但没定义」这一类（下面 §二·b 的浏览器段会真的把它跑出来） ----
     这里先做一遍静态兜底：光有调用点不算数，定义必须在同一个文件里。
     起因：`post()` 收尾里写了 syncButtons()，函数却忘了写 —— 没定义的函数在
     Promise 链里抛 ReferenceError，不弹窗、不写日志，只在控制台一闪而过。 */
  const called = [...lanPage.matchAll(/(?:^|[^.\w])([A-Za-z_$][\w$]*)\s*\(/g)]
    .map(m => m[1])
    .filter(n => /^(sync|refresh|update|render|show)[A-Z]/.test(n));
  const undefinedCalls = [...new Set(called)].filter(n =>
    !new RegExp(`function\\s+${n}\\b`).test(lanPage)
    && !new RegExp(`(?:var|let|const)\\s+${n}\\s*=`).test(lanPage));
  check('导入页里被调用的内部函数都有定义（防「忘了写 function」）',
    undefinedCalls.length === 0,
    undefinedCalls.length ? '未定义：' + undefinedCalls.join(', ') : `检查了 ${[...new Set(called)].length} 个`);
  check('导入页的「重新导入上次的」按钮由状态驱动（syncButtons）',
    /function syncButtons/.test(lanPage) && /id="rre"[^>]*disabled/.test(lanPage));
}

/* ============================================================
   二、宿主 JVM 单测（M3uParser / Source / PlaylistFetcher）
   ============================================================ */
function hostUnitTests() {
  section('宿主 JVM 单测（不需要模拟器）');
  /* 找 JDK：JAVA_HOME → /usr/libexec/java_home → PATH。
     ⚠️ 别写死某台机器的路径 —— 那样别人克隆下来就只能干看着。 */
  /* 找 JDK：逐个候选试，**每个都要验证真的有 bin/javac**。
     ⚠️ 别只认 JAVA_HOME / java_home 的输出就信：
        实测 macOS 上 /usr/libexec/java_home 会返回一个「只有 JRE、没有 javac」
               的路径（装了运行时就以为装了开发包），照单全收就会得到
               「找到 JDK: bin/javac」这种看不懂的失败。
     ⚠️ 也别写死某台机器的路径 —— 那样别人克隆下来就只能干看着。 */
  const hasJavac = d => { try { return existsSync(path.join(d, 'bin', 'javac')); }
                          catch (e) { return false; } };
  const JAVA_CANDIDATES = [
    process.env.JAVA_HOME || '',
    // /usr/libexec/java_home 只在 macOS 上有，别的平台会抛
    (() => { try { return execFileSync('/usr/libexec/java_home', { encoding: 'utf8' }).trim(); }
              catch (e) { return ''; } })(),
    path.join(process.env.HOME || '', '.workbuddy/binaries/jdk/Contents/Home'),
    // PATH 里的 javac，往上两级就是 JAVA_HOME
    (() => { try { const j = execFileSync('which javac', { encoding: 'utf8' }).trim();
                    return j ? path.resolve(path.dirname(j), '..') : ''; }
              catch (e) { return ''; } })(),
  ];
  const javaHome = JAVA_CANDIDATES.find(hasJavac) || '';
  const javac = path.join(javaHome, 'bin/javac');
  const java = path.join(javaHome, 'bin/java');
  if (!existsSync(javac)) {
    check('找到 JDK（有 bin/javac）', false,
      javaHome ? `${javaHome}/bin/javac 不存在` : '本机没找到 JDK：设 JAVA_HOME 或装一个 JDK 11+');
    return;
  }

  const out = '/tmp/ysp-m3utest';
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const srcs = [
    path.join(ROOT, 'tools/hosttest/M3uParserTest.java'),
    path.join(ROOT, 'tools/hosttest/PlaylistFetcherTest.java'),
    path.join(ROOT, 'tools/hosttest/MirrorsTest.java'),
    // v1.11 新增：同步/退订的边界（会删用户数据的那类逻辑，必须能反复验）
    path.join(ROOT, 'tools/hosttest/SourceSyncTest.java'),
    path.join(JAVA_SRC, 'Source.java'),
    path.join(JAVA_SRC, 'M3uParser.java'),
    // v1.11：planSync 在 SourceStore 里（要跟 Android 的读写部分同文件才测得到边界）
    path.join(JAVA_SRC, 'SourceStore.java'),
    // SourceStore 用了 Android 的 SharedPreferences，编不过就得配桩。
    // 桩只为了让 javac 过一遍（方法体一律抛「不该被调用」）——
    // planSync 是纯函数，单测只走它，不碰任何 Android API。
    // org.json 走 SDK 的 android.jar（classpath），不自己写桩。
    path.join(ROOT, 'tools/hosttest/stub/android/content/Context.java'),
    path.join(ROOT, 'tools/hosttest/stub/android/content/SharedPreferences.java'),
    path.join(ROOT, 'tools/hosttest/stub/android/util/Log.java'),
    // Mirrors 也是纯逻辑（镜像归一化 + 选路），必须能跟解析器一起编 ——
    // 「不带 Android 也编得过」本身就是对「零 Android 依赖」的持续校验。
    // 归一化合错了的后果是「点 A 播出 B」，这种错只能靠单测挡住。
    path.join(JAVA_SRC, 'Mirrors.java'),
    // PlaylistFetcher 是纯 JDK 的，所以能跟解析器一起编 —— 这条「不带 Android 也能编过」
    // 本身就是对「零 Android 依赖」的持续校验
    path.join(JAVA_SRC, 'PlaylistFetcher.java'),
  ];
  // org.json 的来源：Android SDK 的 android.jar（只用来编过，运行期单测不碰它）
  const androidJar = [
    path.join(process.env.HOME, 'Library/Android/sdk/platforms/android-34/android.jar'),
  ].find(p => existsSync(p));

  let compile = '';
  try {
    compile = execFileSync(javac,
      ['-d', out, '-encoding', 'UTF-8', '-nowarn',
       ...(androidJar ? ['-cp', androidJar] : []), ...srcs],
      { encoding: 'utf8' });
  } catch (e) { compile = (e.stdout || '') + (e.stderr || ''); }
  if (compile.trim()) console.log(compile.trim().split('\n').slice(0, 10).join('\n'));
  if (!check('单测代码能编译（且 Source/M3uParser/Mirrors/PlaylistFetcher 都不依赖 Android）',
      !/error:/.test(compile), compile.split('\n')[0])) return;

  const runOne = (cls, label) => {
    let run = '';
    try {
      run = execFileSync(java, ['-Dfile.encoding=UTF-8',
        '-cp', androidJar ? out + path.delimiter + androidJar : out,
        'com.ysptv.player.' + cls],
        { encoding: 'utf8', timeout: 60000 });
    } catch (e) { run = (e.stdout || '') + (e.stderr || ''); }
    const m = run.match(new RegExp(cls + ':\\s*(\\d+)\\s*过\\s*\\/\\s*(\\d+)\\s*失败'));
    check(label + '全部通过', m && +m[2] === 0, m ? `${m[1]} 过 / ${m[2]} 失败` : '没解析出结果');
    if (!m || +m[2] > 0) {
      console.log(run.split('\n').filter(l => l.includes('✗')).join('\n'));
    }
  };

  runOne('M3uParserTest', '清单解析单测（含「抓回来的是什么」判定）');
  // PlaylistFetcherTest 在 127.0.0.1 上起 HTTP 桩服务，把重定向 / GBK / gzip /
  // 404 / 超大正文 / 读超时这些「拿真网址测不到」的分支全打一遍
  runOne('PlaylistFetcherTest', '远程抓取单测（本地桩服务，离线可跑）');
  // MirrorsTest 全是纯函数：台名归一化 + 同台选路。
  // 这批用例最要紧的不是「能合上」而是「不能合错」—— 合错了会「点 A 播出 B」。
  runOne('MirrorsTest', '镜像归一化/选路单测（CCTV5 与 CCTV5+ 必须分开、匿名源不分组）');
  // v1.11：同步/退订的边界。这是唯一一批「会删用户数据」的用例 ——
  // 删少了只是没解决问题，删多了会把用户攒的真台清掉，而那种错在设备上
  // 跑一次才知道、跑一次可能就晚了。所以边界规则必须在几毫秒内可反复验。
  runOne('SourceSyncTest', '同步/退订单测（只删属于这份清单的，手加的和别家的一概不动）');
}

/* ============================================================
   三、设备端
   ============================================================ */
let ws, seq = 0;
const pending = new Map();
async function cdpConnect() {
  // ⚠️ 要重试：am start 之后 WebView 的 devtools 端点不是立刻就监听的，
  //    端口转发也可能刚建好还没生效。一次 fetch failed 直接 exit(1)
  //    会把整轮（一分半钟）白跑掉，实测踩过一次。
  let targets = null, lastErr = null;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(CDP + '/json');
      if (r.ok) { targets = await r.json(); break; }
      lastErr = 'HTTP ' + r.status;
    } catch (e) { lastErr = String(e && e.message || e); }
    await sleep(500);
  }
  if (!targets) {
    console.error(`连不上 WebView 调试端口 ${CDP}（试了 20 次）：${lastErr}`);
    console.error('检查：1) adb forward --list 里有没有 tcp:' + PORT +
                  '  2) 设备上 cat /proc/net/unix | grep devtools 的 pid 与 pidof 是否一致');
    process.exit(1);
  }
  const page = targets.find(t => t.type === 'page' && /android_asset/.test(t.url));
  if (!page) {
    console.error('找不到自定义源页面 target：', JSON.stringify(targets.map(t => t.url), null, 2));
    process.exit(1);
  }
  let wsErr = null;
  for (let i = 0; i < 10; i++) {
    ws = new WebSocket(page.webSocketDebuggerUrl);
    try { await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }); wsErr = null; break; }
    catch (e) { wsErr = String(e && e.message || e); await sleep(500); }
  }
  if (wsErr) { console.error('WebSocket 连不上：' + wsErr); process.exit(1); }
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  console.log('  目标页面:', page.url);
}
function send(method, params = {}) {
  const id = ++seq;
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const res = r.result || {};
  if (res.exceptionDetails) throw new Error('JS 异常: ' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails));
  return res.result ? res.result.value : undefined;
}
async function json(expr) {
  const v = await ev(expr);
  return typeof v === 'string' ? JSON.parse(v) : v;
}
async function key(code) {
  adb('shell', 'input', 'keyevent', String(code));
  await sleep(DELAY);
}
function shot(name) {
  const buf = execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 1 << 26 });
  const p = path.join(SHOTS, name + '.png');
  writeFileSync(p, buf);
  return p;
}

/** 画面是真的在放吗 —— 中心区域亮度统计（黑屏/纯色会露馅） */
function frameStats(png, crop = '1200:600:360:240') {
  const out = sh(`ffmpeg -loglevel error -i "${png}" -vf "crop=${crop},signalstats,metadata=print:file=-" -f null -`);
  const g = k => { const m = out.match(new RegExp('signalstats\\.' + k + '=([\\d.]+)')); return m ? +m[1] : null; };
  return { avg: g('YAVG'), min: g('YMIN'), max: g('YMAX') };
}

/**
 * 前台是不是我们的 Activity。
 *
 * ⚠️ 用 `dumpsys activity activities` 的 topResumedActivity，
 *    **不要**用 `dumpsys window` 的 mCurrentFocus：
 *    后者反映的是「窗口层焦点」，模拟器在某些状态下（刚重启、窗口层没聚焦）
 *    会返回 null —— 哪怕 Activity 明明是 resumed 的（实测 topResumedActivity
 *    是我们的 MainActivity、站点页面也加载好了，mCurrentFocus 却是 null）。
 *    拿它判前台会得到一串「前台不是我们的 Activity」的假失败。
 *
 * ⚠️ 这里的包名不能写死 —— 从 build.gradle 的 namespace 读（见文件上方JAVA_SRC）。
 */
function foregroundIsOurs() {
  const d = sh(`"${ADB}" -s ${SERIAL} shell dumpsys activity activities`);
  const m = d.match(new RegExp('topResumedActivity=ActivityRecord\\{[^}]*'
                 + PKG.replace(/\./g, '\\.') + '/\\.([A-Za-z0-9_]+)'));
  return m ? m[1] : null;
}

/**
 * 截一张「确实有画面」的图。
 * 模拟器偶尔会抓到上一帧/布局中的空缓冲（整屏纯色），所以重试几次，
 * 取帧统计最丰富的那张。判定标准：中心区平均亮度够 + 有对比度。
 */
async function shotWithPicture(name, tries = 4) {
  let best = null, bestScore = -1, bestPng = null;
  for (let i = 0; i < tries; i++) {
    const p = shot(name + (i === 0 ? '' : '_r' + i));
    const f = frameStats(p);
    const score = (f.max - f.min) + f.avg / 10;
    if (score > bestScore) { bestScore = score; best = f; bestPng = p; }
    if (f.avg > 40 && (f.max - f.min) > 60) return { png: p, f };
    await sleep(1200);
  }
  return { png: bestPng, f: best };
}

const KEYS = {
  OK: 23, UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, MENU: 82, BACK: 4, BLUE: 186,
};

/**
 * 确保面板是「开着」的 / 「关着」的。
 *
 * ⚠️ 面板 5 秒自动隐藏，而 adb/CDP 的一次往返在机器忙的时候能到好几秒
 *    （实测过一次 screencap 14.7s、一次取值 7.4s）。于是两条断言之间面板
 *    就可能悄悄收起来 —— 紧接着的「下键」从「移光标」变成「换台」，
 *    连锁把后面「确认键选中并收起面板」也带崩。这不是产品 bug，是用例自己脆。
 *    所以凡依赖面板状态的用例，前面都重新确认一次。
 */
async function panelIsOpen() { return !!(await ev('window.__yspTV.isPanelOpen()')); }
async function ensurePanelOpen() {
  if (await panelIsOpen()) return true;
  for (let i = 0; i < 3; i++) {
    await key(KEYS.OK);                 // 收起态下的「确认」= 弹出面板
    if (await panelIsOpen()) return true;
    await sleep(400);
  }
  return false;
}
async function ensurePanelClosed() {
  for (let i = 0; i < 3; i++) {
    if (!(await panelIsOpen())) return true;
    await key(KEYS.BACK);
    await sleep(400);
  }
  return false;
}

/* ============================================================
   二·五、一个只给「从网址导入」用的宿主桩服务
   ============================================================
   为什么要这一坨：真清单（cn_all.m3u8）只会走「200 + UTF-8」这一条路，
   而这一版新写的代码里，重定向、GBK、单个流清单、HTML、404 全是**平时走不到
   的分支** —— 等真在电视上遇到就已经是用户报障了。所以在本机起一个桩，
   让模拟器（10.0.2.2 就是宿主机）去打这些分支。

   ⚠️ 只绑 127.0.0.1：模拟器的 10.0.2.2 会被 SLIRP 转成宿主回环连接，
       绑回环就够，而且不会触发 macOS 的「允许接受传入连接」弹窗。
*/
async function startStubServer() {
  const REMOTE_LIST = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="远程测试",远程台甲',
    'https://remote-list.invalid/a.m3u8',
    '#EXTINF:-1 group-title="远程测试",远程台乙',
    'https://remote-list.invalid/b.m3u8',
    '#EXTINF:-1 group-title="远程测试",远程台丙',
    'https://remote-list.invalid/c.m3u8',
  ].join('\n') + '\n';

  // 跳转目标刻意用不同的台名：这样「到底抓的是跳转后的内容」是能验出来的
  const REDIR_TARGET = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="跳转测试",跳转台甲',
    'https://redir-list.invalid/a.m3u8',
    '#EXTINF:-1 group-title="跳转测试",跳转台乙',
    'https://redir-list.invalid/b.m3u8',
  ].join('\n') + '\n';

  // 给屏上键盘那条路用（走的是 Activity 里的后台线程，不是局域网服务线程）
  const KB_LIST = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="键盘网址",键盘网址台甲',
    'https://kb-list.invalid/a.m3u8',
    '#EXTINF:-1 group-title="键盘网址",键盘网址台乙',
    'https://kb-list.invalid/b.m3u8',
  ].join('\n') + '\n';

  // 一路直播流自己的清单：抓得回来，但它不是频道表 —— 应该被当成「一条源」收下
  const LIVE_MANIFEST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-MEDIA-SEQUENCE:1',
    '#EXTINF:6.000,',
    'seg-1.ts',
  ].join('\n') + '\n';

  const HTML = '<!DOCTYPE html>\n<html><head><meta charset=utf-8><title>需要登录</title></head>'
    + '<body><h1>请先登录后再获取播放列表</h1></body></html>\n';

  // GBK 清单：用【另外一套台名】，好证明「中文台名没被弄坏」这件事真的验到了。
  // Node 的 Buffer 不认 gbk 编码，所以借一下系统 python3 把文本编成 GBK 字节。
  const GBK_TEXT = [
    '#EXTM3U',
    '#EXTINF:-1 group-title="编码测试",编码台甲',
    'https://gbk-list.invalid/a.m3u8',
    '#EXTINF:-1 group-title="编码测试",编码台乙',
    'https://gbk-list.invalid/b.m3u8',
  ].join('\n') + '\n';
  let gbkBuf = null, gbkErr = '';
  try {
    gbkBuf = execFileSync('/usr/bin/python3',
      ['-c', 'import sys;sys.stdout.buffer.write(sys.argv[1].encode("gbk"))', GBK_TEXT],
      { maxBuffer: 1 << 20 });
  } catch (e) { gbkErr = String(e && e.message || e); }

  const srv = createServer((req, res) => {
    const u = (req.url || '').split('?')[0];
    const send = (code, type, body) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length });
      res.end(buf);
    };
    if (u === '/list.m3u8') return send(200, 'text/plain; charset=utf-8', REMOTE_LIST);
    if (u === '/redir.m3u8') { res.writeHead(302, { Location: '/redir-target.m3u8' }); return res.end(); }
    if (u === '/redir-target.m3u8') return send(200, 'text/plain; charset=utf-8', REDIR_TARGET);
    if (u === '/kb.m3u8') return send(200, 'text/plain; charset=utf-8', KB_LIST);
    if (u === '/live.m3u8') return send(200, 'application/vnd.apple.mpegurl', LIVE_MANIFEST);
    if (u === '/page.html') return send(200, 'text/html; charset=utf-8', HTML);
    if (u === '/gbk.m3u8') {
      if (!gbkBuf) return send(500, 'text/plain; charset=utf-8', 'stub 没法生成 GBK：' + gbkErr);
      // 故意【不声明】charset：这正是在测「服务器不告诉编码时能不能靠嗅探认出来」
      return send(200, 'application/octet-stream', gbkBuf);
    }
    if (u === '/gone.m3u8') return send(404, 'text/plain', 'gone');
    send(404, 'text/plain', 'no route ' + u);
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    srv,
    port: srv.address().port,
    base: `http://10.0.2.2:${srv.address().port}`,
    gbkOk: !!gbkBuf,
    gbkErr,
    names: {
      remote: ['远程台甲', '远程台乙', '远程台丙'],
      redir: ['跳转台甲', '跳转台乙'],
      kb: ['键盘网址台甲', '键盘网址台乙'],
      gbk: ['编码台甲', '编码台乙'],
    },
  };
}

async function deviceChecks() {
  section('设备端：安装 + 启动');

  if (!existsSync(APK_DEBUG)) { check('debug APK 已构建', false, APK_DEBUG); return; }
  const inst = sh(`"${ADB}" -s ${SERIAL} install -r "${APK_DEBUG}"`);
  check('安装成功', /Success/.test(inst), inst.split('\n').pop());

  adb('logcat', '-c');
  sh(`"${ADB}" -s ${SERIAL} shell am force-stop com.ysptv.player`);
  sh(`"${ADB}" -s ${SERIAL} shell am start -n com.ysptv.player/.CustomActivity`);
  await sleep(1000);

  const pid = sh(`"${ADB}" -s ${SERIAL} shell pidof com.ysptv.player`).split('\n').pop().trim();
  check('进程活着', /^\d+$/.test(pid), 'pid=' + pid);
  if (!/^\d+$/.test(pid)) return;

  sh(`"${ADB}" -s ${SERIAL} forward --remove-all`);
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  await cdpConnect();

  // 等页面脚本就绪 + 首次起播
  //
  // ⚠️ v1.9 修：原来这里等的是 count() > 0，那等于「等有源」。
  //    1.9 起 App 不再内置示例源，全新安装/清空之后 count() 合法地就是 0 ——
  //    于是这个循环永远等不到，整段判定恒为失败（后面十几条全被它带崩）。
  //    「就绪」的正确判据是 __yspUI 已经挂出来（源可以是 0 条）。
  //    顺带把 v1.9 的新落地页行为也断言掉：零源时 App 会【自动打开源管理】
  //    （onPageReady → openManage()），好让用户直接进入添加流程。
  let ready = false;
  let readyDetail = '';
  for (let i = 0; i < 30; i++) {
    const st = await json(`JSON.stringify({
      ui: typeof window.__yspUI === 'object',
      n: (typeof window.__yspUI === 'object') ? window.__yspUI.count() : -1,
      manage: (typeof window.__yspUI === 'object') ? window.__yspUI.isManageOpen() : null
    })`);
    readyDetail = JSON.stringify(st);
    if (st.ui && st.n >= 0) { ready = true; break; }
    await sleep(500);
  }
  check('页面自动就绪并把源列表推过来了（不需要人工干预，零源也算就绪）',
    ready, readyDetail);
  // 零源落地页：源管理自动开着，第一项就是局域网导入
  const land0 = await json(`JSON.stringify({
    n: __yspUI.count(), manage: __yspUI.isManageOpen(),
    menu0: (__yspUI.menuLabels() || [])[0] || ''
  })`);
  check('零源启动直接落在「源管理」（v1.9 没有示例源，浮层自动打开）',
    land0.n === 0 && land0.manage === true && land0.menu0 === '局域网导入',
    JSON.stringify(land0));
  // 状态层是原生 View，网页里读不到 —— 靠 uiautomator dump 把原生 text 捞出来。
  sh(`"${ADB}" -s ${SERIAL} shell uiautomator dump /sdcard/ui.xml`);
  sh(`"${ADB}" -s ${SERIAL} pull /sdcard/ui.xml /tmp/ysp_ui.xml`);
  const uiOpen = existsSync('/tmp/ysp_ui.xml') ? readFileSync('/tmp/ysp_ui.xml', 'utf8') : '';
  check('浮层开着时零源提示要让位（两者同屏会叠字，实机截图确认过）',
    !/还没有源/.test(uiOpen),
    /还没有源/.test(uiOpen) ? '状态层还在，跟浮层叠在一起了' : '已让位');
  // 后面的用例从「收起态」开始，先关掉
  await ev('__yspUI.closeManage()');
  await sleep(500);
  // v1.9 修掉的一个真 bug：零源提示（原生状态层）和源管理浮层同屏时文字会叠在一起
  //（浮层在左半屏、状态层居中，正好压住菜单右侧的 tail 文案）。
  // 状态层是原生 View，网页里读不到 —— 靠 uiautomator dump 把原生 text 捞出来。
  sh(`"${ADB}" -s ${SERIAL} shell uiautomator dump /sdcard/ui.xml`);
  sh(`"${ADB}" -s ${SERIAL} pull /sdcard/ui.xml /tmp/ysp_ui.xml`);
  const uiClosed = existsSync('/tmp/ysp_ui.xml') ? readFileSync('/tmp/ysp_ui.xml', 'utf8') : '';
  check('浮层关掉后零源提示回到屏幕（这是唯一告诉用户「怎么加源」的地方）',
    /还没有源/.test(uiClosed) && /从剪贴板导入：复制一段地址或清单/.test(uiClosed),
    /还没有源/.test(uiClosed) ? '状态层在' : '状态层没找到（dump 没拿到或已被清掉）');

  /* ---------- 零源默认状态 + 基准源（v1.9：产品不再内置示例源） ---------- */
  // v1.9 起 App 里没有内置示例源了。但后面一堆用例都需要「至少有一条能播的源」——
  // 面板 / 分组 / 删除 / 镜像顺延全都建立在「有一个正在播的行」之上。
  // 所以这里自己导入一条公开测试流当基准，顺带把「从网址导入」这条最常用的路径
  // 放在整套用例的最前面真跑一遍。
  //
  // ⚠️ 这一段必须在下面 st0 快照【之前】：它会重置源列表，而 st0 是后续一堆断言的
  //    基线（st0.playing / st0.n …）—— 基线要是取在重置之前，后面会凭空多出几个失败。
  section('设备端：零源默认状态 + 基准源');

  // 基准源：两条公开的 HLS 测试流。两条都取test-streams.mux.dev 上体积最小的
  // 单流清单（test_001 约 1.6KB / x36xhzz 约 0.7KB），importUrl 会各收成一条源。
  // v1.9 起产品不再内置示例，所以测试自己导。
  //
  // ⚠️ 必须是【两条】，不能一条。1.9 之前这里有 5 条内置示例源垫底，后面一堆用例
  //    都隐含「列表里至少有两行」：
  //      · 面板「下键 = 移光标」：只有 1 行时 move(+1) 原地不动（0 → 0）；
  //      · 删除模式「删掉的正是光标指着的那条 / 正在播的那条没被误删」：
  //        需要一个不是正在播的邻居当靶子，n=1 时 target 算成 -1，靶子直接是 undefined。
  //    这两条以前是靠示例源"顺带"满足的，示例源一撤就集体暴露出隐含前提。
  //
  // ⚠️ 第二条别用 test_002/stream.m3u8：实测模拟器上它 MediaPlayer 报
  //    what=1 extra=-1004（远端断开），不是代码问题，是这条流本身在 TV 上不稳。
  const BASE_URL = 'https://test-streams.mux.dev/test_001/stream.m3u8';
  const BASE_URL2 = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

  // ① 零源就是零源：清空之后不应该有任何东西被塞回来
  await ev('__yspUI.rpc("clear")');
  await sleep(1400);
  const zero = await json(`JSON.stringify({
    n: __yspUI.count(),
    rows: document.querySelectorAll('.tv-main-con-r-list-left > div.ysp-row').length,
    tabs: document.querySelectorAll('.tv-main-con-r-tab-img').length
  })`);
  check('清空后一条源都没有（v1.9：不再内置示例源）', zero.n === 0, `n=${zero.n}`);
  // ⚠️ tab 断言在 v1.9 改了：GROUPS 恒含一个「全部」（站点原生形状，inject.js 的
  //    currentTab() 按 tab 下标算），所以零源时正确状态是「只有『全部』这一个空分组」，
  //    不是「一个 tab 都不留」。原来那条 tabs===0 是 1.9 之前写的，现在必假。
  check('零源时列表为空、只剩一个空的「全部」分组（没有别的台）',
    zero.rows === 0 && zero.tabs === 1,
    `rows=${zero.rows} tabs=${zero.tabs}`);

  // ② 导入基准源：走「从网址导入」（add → importUrl），和用户实际会用的一样。
  //    逐条导入并逐条等：两条并发进去时后一条会被前一条的网络往返压住，
  //    importUrl 最坏要 6s 连接 + 12s 读，串行等最稳。
  for (const u of [BASE_URL, BASE_URL2]) {
    await ev(`__yspUI.rpc("add", "", ${JSON.stringify(u)})`);
    const want = (BASE_URL === u) ? 1 : 2;
    for (let i = 0; i < 40; i++) {          // 单条最多等 20 秒
      await sleep(500);
      if ((await ev('__yspUI.count()')) >= want) break;
    }
  }
  const baseUrls = await json('JSON.stringify(__yspUI.urls())');
  const baseNames = await json('JSON.stringify(__yspUI.names())');
  const baseOk = baseUrls.length === 2;
  check('从网址导入两条公开测试流（基准源就位，列表得有 >=2 行）', baseOk,
    baseOk ? baseNames.join(' / ') : `只导进 ${baseUrls.length} 条：${baseNames.join(' / ')}`);

  /**
   * 播一条源，等它给出明确结论。
   * 「起播成功」不算成功 —— mediaserver 崩溃是起播后约 2 秒才发生的，
   * 所以起播成功后还要再盯 4 秒没出事才算过。
   */
  async function probePlay(url) {
    sh(`"${ADB}" -s ${SERIAL} logcat -c`);
    await ev(`(function(){ __yspUI.rpc("pick", ${JSON.stringify(url)}); return 1; })()`);
    const t0 = Date.now();
    let startedAt = 0;
    while (Date.now() - t0 < 18000) {          // 起播超时是 15 秒，留点余量
      await sleep(500);
      const lg = sh(`"${ADB}" -s ${SERIAL} logcat -d -s YSPTV:V`);
      if (/播放失败/.test(lg)) {
        return { ok: false, why: (lg.match(/播放失败.*/) || [''])[0].replace(/^.*YSPTV\s*:\s*/, '') };
      }
      if (/起播成功/.test(lg)) {
        if (!startedAt) startedAt = Date.now();
        else if (Date.now() - startedAt > 4000) return { ok: true, why: '起播成功且稳定 4 秒' };
      }
    }
    return { ok: false, why: '18 秒内既没起播也没报错（卡住了）' };
  }

  for (let i = 0; i < baseUrls.length; i++) {
    const r = await probePlay(baseUrls[i]);
    check(`基准源能播：${baseNames[i]}`, r.ok, r.ok ? r.why : '❌ ' + r.why);
  }

  // 复位：回到第一条，后面面板用例假设「正在播的那一行」存在
  await ev(`__yspUI.rpc("pick", ${JSON.stringify(baseUrls[0])})`);
  await sleep(4000);

  // ⚠️ 必须显式收起源管理再取基线。v1.9 起零源启动时 App 会【自动打开源管理】
  //    （onPageReady 里 sources.isEmpty() → openManage()，把用户直接送到添加流程，
  //    这是"没有内置示例源"之后唯一合理的落地页）。刚才设备上正是零源，
  //    于是浮层一直开着 —— 后面「确认键弹面板」「光标落在正在播那一行」全会假失败。
  //    这里收干净，让 st0 回到「有源 + 浮层关闭」这个正常播放态。
  await ev('__yspUI.closeManage()');
  await sleep(600);

  const st0 = await json(`JSON.stringify({
    n: __yspUI.count(), groups: __yspUI.groups(), g: __yspUI.currentGroup(),
    rows: document.querySelectorAll('.tv-main-con-r-list-left > div.ysp-row').length,
    tabs: document.querySelectorAll('.tv-main-con-r-tab-img').length,
    playing: __yspUI.playingUrl(), open: __yspTV.isPanelOpen(),
    mode: __yspUI.mode(), panelOn: document.body.classList.contains('ysp-managing')
  })`);
  check('基准源已就位（导入 2 条、正在播第一条）', st0.n === 2 && !!st0.playing,
    `n=${st0.n} playing=${String(st0.playing).slice(-24)}`);
  check('渲染出的行数与源数一致', st0.rows === st0.n, `${st0.rows} vs ${st0.n}`);
  check('分组 tab 建出来了（含「全部」）', st0.tabs === st0.groups.length && st0.groups[0] === '全部',
    st0.groups.join('/'));
  check('默认在播第一条', !!st0.playing);
  check('面板默认收起（不挡画面）', st0.open === false);
  check('管理浮层默认关闭', st0.panelOn === false);

  // 起播确认：前台窗口 + 日志 + 画面像素
  await sleep(4000);
  check('前台是我们的 Activity', !!foregroundIsOurs(), foregroundIsOurs() || '(不是)');
  const logs = sh(`"${ADB}" -s ${SERIAL} logcat -d -s YSPTV:V`);
  check('MediaPlayer 真的 prepared 了（原生 HLS 通路）', /起播成功/.test(logs),
    (logs.match(/起播成功.*/) || [''])[0].slice(0, 60));
  const pic1 = await shotWithPicture('c01_playing');
  check('画面不是黑的（帧统计中心区亮度）',
    pic1.f.avg > 40 && (pic1.f.max - pic1.f.min) > 60,
    `avg=${pic1.f.avg} min=${pic1.f.min} max=${pic1.f.max}`);

  /* ---------- 面板 ---------- */
  section('设备端：选台面板');
  // 先确认是收起态：面板若已展开，下面这个「确认」会变成「选中当前行」
  await ensurePanelClosed();
  await key(KEYS.OK);
  const st1 = await json(`JSON.stringify({
    open: __yspTV.isPanelOpen(), idx: __yspTV.index(),
    focus: (document.querySelector('.tv-main-con-r-list-left > div.ysp-focus')||{}).innerText,
    select: (document.querySelector('.tv-main-con-r-list-left > div.tvSelect')||{}).innerText,
    panelLeft: Math.round(document.querySelector('.tv-main-con-r').getBoundingClientRect().left),
    panelW: Math.round(document.querySelector('.tv-main-con-r').getBoundingClientRect().width)
  })`);
  check('确认键弹出面板', st1.open === true);
  check('面板已滑入屏内', st1.panelLeft === 0, `left=${st1.panelLeft}`);
  check('光标落在正在播放的那一行', (st1.focus || '').trim() === (st1.select || '').trim(),
    `focus=${JSON.stringify(st1.focus)} select=${JSON.stringify(st1.select)}`);

  const geom = await json(`(function(){
    var l = document.querySelector('.tv-main-con-r-list-left');
    var rs = [].slice.call(l.children);
    var hs = rs.map(function(r){ return +r.getBoundingClientRect().height.toFixed(2); });
    var top0 = rs[0].getBoundingClientRect().top - l.getBoundingClientRect().top;
    return JSON.stringify({
      viewH: +l.clientHeight.toFixed(2), rowH: hs[0], n: rs.length,
      uniform: hs.every(function(h){ return Math.abs(h - hs[0]) < 0.6; }),
      perScreen: +(l.clientHeight / hs[0]).toFixed(4),
      scrollTop: l.scrollTop, top0: +top0.toFixed(2)
    });
  })()`);
  check('所有行高一致', geom.uniform, `rowH=${geom.rowH}`);
  check('一屏正好装下整数行（不露半行）',
    Math.abs(geom.perScreen - Math.round(geom.perScreen)) < 0.08,
    `viewH/rowH=${geom.perScreen}`);
  check('滚动位置对齐到行高整数倍',
    Math.abs(geom.scrollTop % geom.rowH) < 0.6 || geom.scrollTop === 0,
    `scrollTop=${geom.scrollTop} rowH=${geom.rowH}`);

  shot('c02_panel');

  /* ⚠️ 本页【故意】复用了 inject.js（custom.html 造出一样的 DOM 形状，好让面板
     观感/滚动/手势全部复用）。1.5.1 时那行「自定义源」入口【不】准出现在本页：
     它的动作是开 CustomActivity，在这里再开一次就是自指，而且本页没有 yspBridge，
     点上去只会弹一句「桥接缺失」。
     1.8 起反过来了：入口在本页【必须】出现，但动作换成「打开源管理」
     （inject.js 的 entryIsAdd() 靠 yspCustom 桥区分两种页面）——
     用户反馈「没有添加自定义源的位置」，这就是补上的那个看得见的入口。
     所以这条从「不能自指」翻成「必须挂出来、且动作没指回自己」。 */
  const selfRef = await json(`JSON.stringify({
    bridge: !!window.yspBridge,
    has: !!document.getElementById('ysp-custom-entry'),
    wanted: (typeof __yspTV.entryWanted === 'function') ? __yspTV.entryWanted() : null,
    text: ((document.getElementById('ysp-custom-entry')||{}).textContent||'').trim(),
    addCls: String((document.getElementById('ysp-custom-entry')||{}).className||'').indexOf('ysp-entry-add') >= 0,
    inList: !!(document.getElementById('ysp-custom-entry')
               && document.querySelector('.tv-main-con-r-list-left')
               && document.querySelector('.tv-main-con-r-list-left')
                      .contains(document.getElementById('ysp-custom-entry')))
  })`);
  check('自定义源页也挂着入口（v1.8：可见的「＋ 添加自定义源」）',
    selfRef.has === true && selfRef.wanted === true,
    `bridge=${selfRef.bridge} has=${selfRef.has} wanted=${selfRef.wanted}`);
  check('入口是「添加」变体，不是主界面那行「打开自定义源」',
    selfRef.addCls === true && /添加/.test(selfRef.text),
    `text=${JSON.stringify(selfRef.text)} addCls=${selfRef.addCls}`);
  check('入口仍然在频道列表之外（不污染 rows()/count）', selfRef.inList === false);

  // 遥控器可达性：大跨度回顶不误进入口；第 0 行再按一次【单步】上才进
  check('入口用例前面板仍是展开的', await ensurePanelOpen());
  await ev('__yspTV.move(-99)');
  await sleep(250);
  const en0 = await json(`JSON.stringify({
    idx: __yspTV.index(), onEntry: __yspTV.onEntry(),
    entryFocus: !!document.getElementById('ysp-custom-entry').classList.contains('ysp-focus')
  })`);
  check('大跨度回顶 move(-99) 落在第 0 行、不误进入口',
    en0.idx === 0 && en0.onEntry === false && en0.entryFocus === false,
    `idx=${en0.idx} onEntry=${en0.onEntry}`);
  await key(KEYS.UP);
  await sleep(300);
  const en1 = await json(`JSON.stringify({
    onEntry: __yspTV.onEntry(),
    entryFocus: !!document.getElementById('ysp-custom-entry').classList.contains('ysp-focus'),
    rowFocus: !!document.querySelector('.tv-main-con-r-list-left > div.ysp-focus')
  })`);
  check('第 0 行再按一次上 → 光标落在「＋ 添加自定义源」入口上',
    en1.onEntry === true && en1.entryFocus === true && en1.rowFocus === false,
    `onEntry=${en1.onEntry} entryFocus=${en1.entryFocus} rowFocus=${en1.rowFocus}`);
  shot('c02b_entry_add');

  // 确认键：打开「源管理」浮层（不是自指打开 CustomActivity，人还在本页）
  await key(KEYS.OK);
  await sleep(500);
  const en2 = await json(`JSON.stringify({
    manage: __yspUI.isManageOpen(),
    menu0: (__yspUI.menuLabels()||[])[0] || ''
  })`);
  check('入口上按确认 → 打开「源管理」浮层（第一项就是局域网导入）',
    en2.manage === true && en2.menu0 === '局域网导入',
    `manage=${en2.manage} menu0=${JSON.stringify(en2.menu0)}`);
  shot('c02c_manage_from_entry');
  // 收起来，把面板态还给后面的用例
  await ev('__yspUI.key("BACK")');
  await sleep(300);
  check('返回键收起源管理，回到面板态', (await ev('__yspUI.isManageOpen()')) === false);

  // 上下移动光标
  check('光标用例前面板仍是展开的（慢机器上自动隐藏会吃掉这条）', await ensurePanelOpen());
  const before = await ev('__yspTV.index()');
  await key(KEYS.DOWN);
  const after = await ev('__yspTV.index()');
  check('面板里下键 = 移光标（不换台）', after === before + 1, `${before} → ${after}`);
  const stillPlaying = await ev('__yspUI.playingUrl()');
  check('移光标时没有换台', stillPlaying === st0.playing,
    `playing=${String(stillPlaying).slice(-40)} 期望=${String(st0.playing).slice(-40)}`);

  // 选中 → 换台（会真的重新起播）
  check('选中用例前面板仍是展开的', await ensurePanelOpen());
  await key(KEYS.OK);
  const st2 = await json(`JSON.stringify({
    open: __yspTV.isPanelOpen(), playing: __yspUI.playingUrl(),
    select: (document.querySelector('.tv-main-con-r-list-left > div.tvSelect')||{}).innerText,
    toast: (document.getElementById('ysp-toast')||{}).textContent
  })`);
  check('确认键选中该源并收起面板', st2.open === false,
    `open=${st2.open} playing=${String(st2.playing).slice(-40)} select=${JSON.stringify(st2.select)}`);
  check('播放地址已经切到新选的这条', st2.playing !== st0.playing);
  check("换台气泡显示了台名", !!(st2.toast || '').trim(), JSON.stringify(st2.toast));

  await sleep(6000);
  const logs2 = sh(`"${ADB}" -s ${SERIAL} logcat -d -s YSPTV:V`);
  check('第二条源同样起播成功（换台不残留坏 MediaPlayer）',
    (logs2.match(/起播成功/g) || []).length >= 2,
    `起播成功 ×${(logs2.match(/起播成功/g) || []).length}`);
  const pic2 = await shotWithPicture('c03_switched');
  check('切换后画面正常', pic2.f.avg > 40, `avg=${pic2.f.avg} min=${pic2.f.min} max=${pic2.f.max}`);

  /* ---------- 分组 ---------- */
  section('设备端：分组切换');
  await ensurePanelClosed();       // 确认键必须落在「收起态」才是弹面板
  await key(KEYS.OK);              // 弹面板
  await key(KEYS.RIGHT);           // 切到第 2 个分组
  const st3 = await json(`JSON.stringify({
    g: __yspUI.currentGroup(), gi: __yspUI.currentGroupIndex(),
    probe: __yspTV.currentTab(),
    rows: document.querySelectorAll('.tv-main-con-r-list-left > div.ysp-row').length,
    on: [].slice.call(document.querySelectorAll('.tv-main-con-r-tab-img')).map(function(t){return t.className;})
  })`);
  check('右键切到下一个分组', st3.gi === 1 && st3.g === st0.groups[1], `${st3.g}(${st3.gi})`);
  check('inject.js 的 currentTab() 读到的是我们的分组（探针生效）', st3.probe === 1, `probe=${st3.probe}`);
  // 注意别用 /on/ 直接测 —— "tv-main-CON-r-tab-img" 自己就含 "on"
  check('tab 选中态跟着走',
    /(^|\s)on(\s|$)/.test(st3.on[1] || '') && !/(^|\s)on(\s|$)/.test(st3.on[0] || ''),
    JSON.stringify(st3.on));
  await key(KEYS.LEFT);
  const st3b = await ev('__yspUI.currentGroupIndex()');
  check('左键切回上一个分组', st3b === 0);
  await key(KEYS.BACK);            // 收面板
  await sleep(300);

  /* ---------- 管理浮层 ---------- */
  section('设备端：管理浮层 + 局域网导入');
  await key(KEYS.MENU);
  await sleep(900);                 // 等局域网服务起来
  const st4 = await json(`JSON.stringify({
    open: __yspUI.isManageOpen(), items: __yspUI.menuLabels(),
    lan: __yspUI.lanUrl(), err: __yspUI.lanError(),
    cardOn: document.getElementById('ysp-manage').classList.contains('on'),
    panelHidden: getComputedStyle(document.querySelector('.tv-main-con-r')).display === 'none'
  })`);
  check('菜单键打开管理浮层', st4.open === true && st4.cardOn === true);
  check('浮层打开时面板已摘下（避免误触背后换台）', st4.panelHidden === true);
  check('菜单项齐全（v1.9：加了「从剪贴板导入」，去掉「恢复内置示例源」）',
    ['局域网导入', '从剪贴板导入', '屏上输入新源', '选台播放', '删除源', '清空全部源', '关闭']
      .every(x => st4.items.includes(x)), st4.items.join(' | '));
  check('菜单里不再有「恢复内置示例源」（示例源已整个去掉）',
    !st4.items.includes('恢复内置示例源'), st4.items.join(' | '));
  check('局域网服务给出了可访问地址', /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\//.test(st4.lan),
    st4.lan + (st4.err ? ' err=' + st4.err : ''));
  shot('c04_manage');

  if (/^http:\/\/\d+\.\d+\.\d+\.\d+:(\d+)\//.test(st4.lan)) {
    const devPort = +st4.lan.match(/:(\d+)\//)[1];
    sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:8099`);
    adb('forward', 'tcp:8099', `tcp:${devPort}`);

    const listRes = await fetch('http://127.0.0.1:8099/api/list').then(r => r.json()).catch(e => ({ err: String(e) }));
    check('GET /api/list 返回现有源', listRes && typeof listRes.total === 'number' && listRes.total > 0,
      `total=${listRes && listRes.total}`);

    const page = await fetch('http://127.0.0.1:8099/').then(r => r.text()).catch(e => '');
    check('GET / 返回导入表单页', /自定义源导入/.test(page) && /<textarea/.test(page));

    // 地址刻意用不存在的域名：解析器不联网，这样能保证不会跟内置示例源撞车
    const m3u = [
      '#EXTM3U',
      '#EXTVLCOPT:http-user-agent=LanTest/1.0',
      '#EXTINF:-1 group-title="局域网测试",测试台甲',
      'https://lan-test-import.invalid/a.m3u8',
      '#EXTINF:-1 group-title="局域网测试",测试台乙',
      'https://lan-test-import.invalid/b.m3u8',
      // 故意重复一条，验证按网址去重
      '#EXTINF:-1,重复台',
      'https://lan-test-import.invalid/a.m3u8',
    ].join('\n');
    const addRes = await fetch('http://127.0.0.1:8099/api/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'text=' + encodeURIComponent(m3u) + '&name=',
    }).then(r => r.json()).catch(e => ({ err: String(e) }));
    check('POST /api/add 解析出 3 条、去重后只加 2 条',
      addRes.ok === true && addRes.added === 2 && addRes.parsed === 3,
      JSON.stringify(addRes));

    // 电视这边的界面应该自己刷新了
    await sleep(1200);
    const st5 = await json(`JSON.stringify({
      n: __yspUI.count(), groups: __yspUI.groups(),
      names: __yspUI.names(), urls: __yspUI.urls()
    })`);
    check('导入后电视上的列表自动刷新了', st5.n === st0.n + 2, `n=${st5.n}`);
    check('新分组出现在 tab 里', st5.groups.includes('局域网测试'), st5.groups.join('/'));
    check('带分组的台名进得来', st5.names.includes('测试台甲') && st5.names.includes('测试台乙'));
    const hdrs = await json('JSON.stringify(__yspUI.headers())');
    check('m3u 里的 EXTVLCOPT 请求头一起解析并传到了界面',
      hdrs.some(h => h && h['User-Agent'] === 'LanTest/1.0'),
      JSON.stringify(hdrs.filter(Boolean).slice(0, 2)));

    // 清空
    const clr = await fetch('http://127.0.0.1:8099/api/clear', { method: 'POST' })
      .then(r => r.json()).catch(e => ({ err: String(e) }));
    check('POST /api/clear 清空成功', clr.ok === true, JSON.stringify(clr));
    await sleep(1200);
    check('清空后电视上的列表也空了', (await ev('__yspUI.count()')) === 0);
    check('清空之后不会被示例源自动填回来（v1.9 没有内置示例）',
      (await ev('__yspUI.count()')) === 0, `n=${await ev('__yspUI.count()')}`);
    // 把两条基准源放回去，别把后面的用例留成空列表
    // （两条：面板移光标 / 删除模式都要 >=2 行，理由见 BASE_URL2 处注释）
    // 逐条等：master 清单那条要抓一次才收得下（见 BASE_URL2 处注释）
    for (const u of [BASE_URL, BASE_URL2]) {
      await ev(`__yspUI.rpc("add", "", ${JSON.stringify(u)})`);
      const want = (BASE_URL === u) ? 1 : 2;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        if ((await ev('__yspUI.count()')) >= want) break;
      }
    }
    const after = await ev('__yspUI.count()');
    check('重新导入基准源（后续用例需要列表里有两条可播的）', after === 2, `n=${after}`);

    /* ================================================================
       从网址导入（1.3 新增）：给 App 一个清单的网址，让它自己去抓
       ================================================================ */
    section('设备端：从网址导入（远程清单，由 App 侧抓取）');

    const stub = await startStubServer();
    console.log(`    · 宿主桩服务 ${stub.base}  （/list /redir /kb /live /page /gbk /gone）`);

    const postAddUrl = (url) => fetch('http://127.0.0.1:8099/api/addurl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: 'url=' + encodeURIComponent(url),
    }).then(r => r.json()).catch(e => ({ err: String(e) }));
    const apiList = () => fetch('http://127.0.0.1:8099/api/list', { cache: 'no-store' })
      .then(r => r.json()).catch(e => ({ err: String(e) }));
    const snap = () => json(`JSON.stringify({
      n: __yspUI.count(), names: __yspUI.names(), groups: __yspUI.groups(),
      urls: __yspUI.urls(), remote: __yspUI.remoteUrl(), menu: __yspUI.menuLabels()
    })`);

    /* ---- ① 普通 UTF-8 清单：应该整份导入 ---- */
    let sn = await snap();
    const nBeforeUrl = sn.n;
    const r1 = await postAddUrl(stub.base + '/list.m3u8');
    await sleep(1600);
    sn = await snap();
    check('POST /api/addurl 认出来这是一份清单（isList）',
      r1.ok === true && r1.isList === true, JSON.stringify(r1));
    check('整份导入 3 条', r1.added === 3 && sn.n === nBeforeUrl + 3,
      `${JSON.stringify(r1)} / n ${nBeforeUrl}→${sn.n}`);
    check('清单里的分组名进了 tab', sn.groups.includes('远程测试'), sn.groups.join('/'));
    check('三个台名都对（抓取→解码→解析 全程没坏）',
      stub.names.remote.every(x => sn.names.includes(x)),
      sn.names.filter(x => String(x).indexOf('远程') === 0).join('/') || '(一个都没有)');

    /* ---- ② 清单地址被记住 + 菜单多出「刷新远程清单」 ---- */
    const api1 = await apiList();
    check('/api/list 回报了记住的清单地址',
      typeof api1.remote === 'string' && api1.remote.endsWith('/list.m3u8'), api1.remote);
    check('电视页面上也同步到了这个地址',
      String(sn.remote).endsWith('/list.m3u8'), sn.remote);
    check('菜单里出现了「同步这份清单」（v1.11 起它真的会删条目）',
    sn.menu.includes('同步这份清单') && !sn.menu.includes('刷新远程清单'), sn.menu.join(' | '));
    check('刷新项紧跟在「屏上输入新源」之后（菜单下标不能错位）',
      sn.menu.indexOf('同步这份清单') === sn.menu.indexOf('屏上输入新源') + 1, sn.menu.join(' | '));

    /* ---- ②a 导入页在【真浏览器】里跑一遍：不许有未捕获异常 ----
       为什么非要有这一段：前面所有 /api/* 断言都是直接 fetch 的，等于绕过了页面脚本。
       于是「函数只写了调用、忘了写定义」这类错误可以一路全绿 ——
       它在 Promise 链里抛 ReferenceError，不弹窗、不写日志，
       用户看到的现象只是「点了按钮好像没反应」。这一段把页面真的跑起来，把它逼出来。
       顺带在页面上真点一次「重新导入上次的」，覆盖 post() 那条收尾路径 ——
       此刻记住的地址是上面那个桩服务的 /list.m3u8（本机、快），
       而且三条件目地址与已导入的完全一样，合并去重后源数量不该变。 */
    {
      const { chromium } = await import('playwright-core');
      const browser = await chromium.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--no-sandbox', '--disable-gpu'],
      });
      const bp = await (await browser.newContext({ viewport: { width: 440, height: 1180 } })).newPage();
      const jsErr = [];
      bp.on('pageerror', e => jsErr.push(String((e && e.message) || e)));
      await bp.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });
      await bp.waitForTimeout(600);
      check('导入页在真实浏览器里加载时不抛 JS 未捕获异常',
        jsErr.length === 0, jsErr.slice(0, 2).join(' / ') || '0 个');

      const box = await bp.evaluate(() => ({
        remembered: document.getElementById('rmem').classList.contains('on'),
        reDisabled: document.getElementById('rre').disabled,
      }));
      check('「重新导入上次的」的可用性跟着「记住的地址」走（不是跟着请求结束走）',
        box.remembered === true && box.reDisabled === false, JSON.stringify(box));

      const nBeforeUi = (await snap()).n;
      await bp.click('#rre');
      await bp.waitForTimeout(6000);
      const uiMsg = (await bp.textContent('#rmsg')) || '';
      check('在页面上点「重新导入上次的」能刷成功（走的是页面那条路）',
        /清单已更新/.test(uiMsg), uiMsg.trim());
      check('点完之后页面仍然没有 JS 未捕获异常（post() 收尾路径）',
        jsErr.length === 0, jsErr.slice(0, 2).join(' / ') || '0 个');
      const box2 = await bp.evaluate(() => ({
        reDisabled: document.getElementById('rre').disabled,
        disabledAttr: document.getElementById('rre').hasAttribute('disabled'),
      }));
      check('刷新完按钮没有被锁死（还能再点一次）', box2.reDisabled === false, JSON.stringify(box2));
      await sleep(1600);
      const nAfterUi = (await snap()).n;
      check('刷新是「并集」不是「覆盖」：已有的台不会被重复加一遍',
        nAfterUi === nBeforeUi, `${nBeforeUi} → ${nAfterUi}`);
      await browser.close();
    }

    /* ---- ②b 菜单比卡片高：光标走到每一项，高亮那行都必须在可见区内 ---- */
    //
    // 这一段是截图上肉眼看出来的：v1.3 多了「刷新远程清单」这一项、头部又多了一组
    // 「已记住的清单」地址之后，`.mg-card` 的 84vh 装不下 —— `.mg-list` 虽然写了
    // overflow-y:auto，却【没人去滚它】，于是光标走过第 4 项，高亮那行就在卡片外面，
    // 按键照样有反应、用户看不见自己在哪。加之前其实已经临界，只是裁剪量小。
    await ev('__yspUI.openManage()');
    await sleep(400);
    const nItems = sn.menu.length;
    // 先连按 n 次 UP 转满一圈回到原处（UP 在首项会绕到末项），拿到一个确定的起点
    await ev(`(function(){ for (var k=0;k<${nItems};k++) __yspUI.key('UP'); return 1; })()`);
    const offscreen = [];
    const seenIdx = new Set();
    for (let i = 0; i < nItems; i++) {
      const g = await json(`JSON.stringify((function(){
        var list=document.querySelector('#mgCard .mg-list');
        var on=list.querySelector('.mg-item.on');
        var lr=list.getBoundingClientRect(), or=on.getBoundingClientRect();
        return { i: __yspUI.menuIndex(), label: on.querySelector('.mg-label').textContent,
                 inView: or.top >= lr.top - 2 && or.bottom <= lr.bottom + 2,
                 scrollTop: Math.round(list.scrollTop),
                 max: Math.round(list.scrollHeight - list.clientHeight) };
      })())`);
      seenIdx.add(g.i);
      if (!g.inView) offscreen.push(`${g.i}:${g.label}`);
      await ev('__yspUI.key("DOWN")');
    }
    check('菜单光标走到每一项时，高亮那行都留在可见区内（本用例的核心）',
      offscreen.length === 0 && seenIdx.size === nItems,
      (offscreen.length
        ? '跑到卡片外的：' + offscreen.join(' / ')
        : `${nItems} 项每一项都滚到了、光标所在那行始终在可见区`));

    /* ---- ②c 列表放不下时，边缘必须写明「还有多少项」 ----
       ⚠️ 「光标可见」和「知道下面还有东西」是两件事：
          scrollMenuIntoView() 只保证前者 —— 光标停在第一项时，后面几项照样被裁在卡片外，
          而滚动条是关掉的（电视上不该出现滚动条）。没有这条提示，截图上看就是
          「菜单只有 4 项」，用户根本不会想到还要往下按。
          这是 v1.3 截图上连着看出来的第二个问题：修了「看得见光标」，
          还得修「知道下面还有」。 */
    const geom = await json(`JSON.stringify((function(){
      var list=document.querySelector('#mgCard .mg-list');
      return { max: Math.round(list.scrollHeight - list.clientHeight),
               rows: list.querySelectorAll('.mg-item').length };
    })())`);
    check('前提成立：这个菜单确实放不下（否则提示条本来就不该出现）', geom.max > 0,
      `可滚 ${geom.max}px · ${geom.rows} 项`);

    // 把光标按回第一项：UP 在首项会绕到末项，所以按「当前下标」次一定回到 0
    const curIdx = await ev('__yspUI.menuIndex()');
    await ev(`(function(){ for (var k=0;k<${curIdx};k++) __yspUI.key('UP'); return 1; })()`);
    await sleep(250);
    const hintTop = await json(`JSON.stringify((function(){
      var m=document.querySelector('#mgCard .mg-more');
      var list=document.querySelector('#mgCard .mg-list');
      var lr=list.getBoundingClientRect(), n=0;
      [].slice.call(list.querySelectorAll('.mg-item')).forEach(function(r){
        if (r.getBoundingClientRect().top >= lr.bottom - 1) n++;
      });
      return { on: m && m.classList.contains('on'), text: (m && m.textContent) || '',
               below: n, idx: __yspUI.menuIndex() };
    })())`);
    check('光标在第一项时，提示条写着「下面还有」',
      hintTop.idx === 0 && hintTop.on === true
      && /下面还有/.test(hintTop.text) && !/上面还有/.test(hintTop.text),
      `idx=${hintTop.idx} 「${hintTop.text}」`);
    check('提示里的项数与实际被裁掉的项数一致（不是写死的）',
      hintNum(hintTop.text, '下') === hintTop.below,
      `提示说 ${hintNum(hintTop.text, '下')} 项 · 实际被裁 ${hintTop.below} 项`);

    // 再按一次 UP：首项绕到末项，提示该翻过来
    await ev('__yspUI.key("UP")');
    await sleep(250);
    const hintBot = await json(`JSON.stringify((function(){
      var m=document.querySelector('#mgCard .mg-more');
      var list=document.querySelector('#mgCard .mg-list');
      var lr=list.getBoundingClientRect(), n=0;
      [].slice.call(list.querySelectorAll('.mg-item')).forEach(function(r){
        if (r.getBoundingClientRect().bottom <= lr.top + 1) n++;
      });
      return { on: m && m.classList.contains('on'), text: (m && m.textContent) || '',
               above: n, idx: __yspUI.menuIndex() };
    })())`);
    check('光标跳到末项后，提示改成「上面还有」且下面那句要收掉',
      hintBot.idx === nItems - 1 && hintBot.on === true
      && /上面还有/.test(hintBot.text) && !/下面还有/.test(hintBot.text),
      `idx=${hintBot.idx} 「${hintBot.text}」`);
    check('上面那句的项数也对', hintNum(hintBot.text, '上') === hintBot.above,
      `提示说 ${hintNum(hintBot.text, '上')} 项 · 实际被裁 ${hintBot.above} 项`);

    // 边缘淡出：被裁掉的那半行必须被 mask 抹掉，不能一截一截地露在卡片口上。
    // 用 getComputedStyle 读 mask-image，确认 class 真的生效了（不是只挂了个名字）。
    const edge = await json(`JSON.stringify((function(){
      var list=document.querySelector('#mgCard .mg-list');
      var cs=getComputedStyle(list);
      return { cls: list.className,
               mask: String(cs.webkitMaskImage || cs.maskImage || 'none') };
    })())`);
    check('光标在末项（下面没有了）时，列表不再向下淡出',
      /cut-top|cut-both/.test(edge.cls) && !/cut-bot/.test(edge.cls), edge.cls);
    check('确实挂上了 mask（不是只加了个 class 名字）',
      edge.mask !== 'none' && /gradient/.test(edge.mask), edge.mask.slice(0, 72));

    /* ---- ③ 刷新：重抓一次，已存在的条目不该重复导入 ---- */
    sh(`"${ADB}" -s ${SERIAL} logcat -c`);
    await ev('__yspUI.rpc("refresh")');
    await sleep(2600);
    const sn2 = await snap();
    check('刷新远程清单：已存在的条目不会重复导入', sn2.n === sn.n, `${sn.n} → ${sn2.n}`);
    const lgRefresh = sh(`"${ADB}" -s ${SERIAL} logcat -d -s YSPTV:V`);
    check('同步确实抓了这份清单（日志里有「清单已更新」）', /清单已更新/.test(lgRefresh),
      (lgRefresh.match(/刷新远程清单.*/) || [''])[0].slice(0, 96));

    /* ---- ④ 302 跳转：要跟到目标页，而且抓的是跳转【之后】的内容 ---- */
    const r2 = await postAddUrl(stub.base + '/redir.m3u8');
    await sleep(1600);
    const sn3 = await snap();
    check('302 跳转的清单能跟着抓到', r2.ok === true && r2.added === 2, JSON.stringify(r2));
    check('抓到的是跳转之后的内容（台名来自目标页）',
      stub.names.redir.every(x => sn3.names.includes(x)),
      sn3.names.filter(x => String(x).indexOf('跳转') === 0).join('/') || '(一个都没有)');

    /* ---- ⑤ GBK（而且服务器不声明编码）：中文不能变乱码 ---- */
    if (stub.gbkOk) {
      const r3 = await postAddUrl(stub.base + '/gbk.m3u8');
      await sleep(1600);
      const sn4 = await snap();
      check('GBK 清单（服务器还没声明 charset）能正确解码',
        r3.ok === true && r3.added === 2, JSON.stringify(r3));
      check('GBK 的中文台名没变成乱码',
        stub.names.gbk.every(x => sn4.names.includes(x)),
        sn4.names.filter(x => String(x).indexOf('编码') === 0).join('/') || '(一个都没有)');
    } else {
      check('GBK 清单（服务器还没声明 charset）能正确解码', false,
        '本机生成 GBK 失败：' + stub.gbkErr);
    }

    /* ---- ⑥ 一路直播流：抓得回来，但它不是频道表，只能收下这一条 ---- */
    const nBeforeLive = (await snap()).n;
    const r4 = await postAddUrl(stub.base + '/live.m3u8');
    await sleep(1600);
    const sn5 = await snap();
    check('抓到的是直播流本身 → 只收下这一条（isList=false）',
      r4.ok === true && r4.isList === false && r4.added === 1, JSON.stringify(r4));
    check('没有把这份分片清单拆成几十个假频道', sn5.n === nBeforeLive + 1,
      `${nBeforeLive} → ${sn5.n}`);
    check('收下的就是那个地址本身', sn5.urls.includes(stub.base + '/live.m3u8'));

    /* ---- ⑦ 一张网页：也不能被当频道表解析 ---- */
    const r5 = await postAddUrl(stub.base + '/page.html');
    await sleep(1600);
    check('抓回来是网页 → 按单条源收下（不会去解析页面里的链接）',
      r5.ok === true && r5.isList === false && r5.added === 1, JSON.stringify(r5));

    /* ---- ⑧ HTTP 404：抓不到也照收，但提示要说清是「没抓到清单」 ---- */
    const r6 = await postAddUrl(stub.base + '/gone.m3u8');
    await sleep(1600);
    check('404 的地址也会被收下（抓不到清单 ≠ 播不了）',
      r6.ok === true && r6.added === 1, JSON.stringify(r6));
    check('提示里说明了「没抓到清单」', /没抓到清单/.test(r6.msg || ''), r6.msg);

    /* ---- ⑨ 屏上键盘那条路（走 Activity 的后台线程，不是局域网服务线程） ---- */
    const nKb = (await snap()).n;
    await ev(`__yspUI.rpc("add","",${JSON.stringify(stub.base + '/kb.m3u8')})`);
    await sleep(2600);
    const sn8 = await snap();
    check('屏上键盘里填清单网址也能整份导入', sn8.n === nKb + 2, `${nKb} → ${sn8.n}`);
    check('键盘那条路的台名也对',
      stub.names.kb.every(x => sn8.names.includes(x)),
      sn8.names.filter(x => String(x).indexOf('键盘') === 0).join('/') || '(一个都没有)');

    /* ================================================================
       ⑩ 真实第三方清单：用户给的那个地址，直接拿来当导入目标
       ================================================================ */
    section('设备端：真实第三方清单（用户给的那个地址）');
    console.log(`    · 目标：${REAL_LIST}`);
    const nReal = (await snap()).n;
    const r7 = await postAddUrl(REAL_LIST);
    await sleep(2500);
    const sn9 = await snap();
    check('真清单能直接当导入目标（抓取 → 判定 → 整份导入）',
      r7.ok === true && r7.isList === true && r7.added > 0,
      JSON.stringify(r7).slice(0, 170));
    check('源数量确实涨了', sn9.n === nReal + r7.added, `${nReal} → ${sn9.n}（added=${r7.added}）`);
    check('这份清单自己带的台名/分组进来了（不是被当成一条源）',
      sn9.names.length === sn9.urls.length && sn9.groups.length > 5,
      `分组 ${sn9.groups.length} 个：${sn9.groups.slice(0, 6).join('/')}…`);
    const api2 = await apiList();
    check('记住的地址换成了这份真清单',
      typeof api2.remote === 'string' && api2.remote.endsWith('cn_all.m3u8'), api2.remote);

    /* ---- 收尾：清空成零源，但清单地址要留着 ---- */
    await ev('__yspUI.rpc("clear")');
    await sleep(1400);
    const snEnd = await snap();
    check('收尾：源已清空（v1.9 不再自动填示例）', snEnd.n === 0, `n=${snEnd.n}`);
    check('「清空全部」之后清单地址仍然留着（这是一键拉回来的前提）',
      String(snEnd.remote).length > 0, snEnd.remote);
    stub.srv.close();

    sh(`"${ADB}" -s ${SERIAL} forward --remove tcp:8099`);
  }

  /* ================================================================
     ⑨-补 从剪贴板导入（v1.9）
     ================================================================
     为什么要有这一条：电视上没有任何「粘贴」键，屏上键盘是一个字符一个字符敲。
     用户在手机上复制一段 m3u/地址，电视这边唯一能用的入口就是系统剪贴板。

     这一节测的是两段：
       · JS 侧 clipResult() 的分派（单行网址 → add；多行文本 → addText）；
       · 真·Java 桥（rpc('clip') → UiBridge.clip() → getPrimaryClip →
         JSONObject.quote → __yspUI.clipResult 回调）。
     模拟器上剪贴板是空的，所以走桥那条只能验到「空 → 明确提示」这一支；
     有内容的分支用直接调 clipResult 来覆盖（分派逻辑在同一处）。
     ⚠️ 用 invalid 域名：解析器不联网，保证不会跟真清单里的台撞车。
     ================================================================ */
  section('设备端：从剪贴板导入（v1.9 新增）');
  {
    await ev('__yspUI.closeManage()');
    await sleep(300);

    // 菜单里得有这一项，且按下会真的走 Java 桥（模拟器剪贴板为空 → 应给出明确提示）
    await ev('__yspUI.openManage()');
    await sleep(500);
    const clipIdx = (await json('JSON.stringify(__yspUI.menuLabels())')).indexOf('从剪贴板导入');
    check('菜单里有「从剪贴板导入」', clipIdx >= 0, 'idx=' + clipIdx);
    await ev('__yspUI.rpc("clip")');
    await sleep(1200);
    const clipToast = await json('JSON.stringify((document.getElementById("ysp-toast")||{}).textContent||"")');
    // ⚠️ 不能只断言「剪贴板是空的」：模拟器剪贴板里可能残留着别的套件
    //    （iptv_realworld / 手机点击套件）塞进去的真清单地址，那样会走「导入成功」
    //    分支，断言必假。要断言的是「走 Java 桥读到了剪贴板并给了反馈」——
    //    三种结果（空 / 导入中 / 导入成功）都算有反馈，静悄悄才算坏。
    // ⚠️ 断言要覆盖剪贴板里可能是【任何东西】的情况：模拟器上常残留着
    //    别的套件（或人）放进去的网址/文本，那会走「已添加：xxx」或「导入成功」分支。
    //    真正要保证的是「Java 桥被调用了、并且给了反馈」——
    //    静悄悄（toast 为空）才是坏。
    check('走 Java 桥读剪贴板有明确反馈（内容任意，但不能静悄悄）',
      clipToast.length > 0, JSON.stringify(clipToast));
    await ev('__yspUI.rpc("clear")');
    await sleep(1200);
    await ev('__yspUI.closeManage()');
    await sleep(300);

    // ① 空串：不动列表
    const nClip0 = await ev('__yspUI.count()');
    await ev('__yspUI.clipResult("")');
    await sleep(400);
    const emptyMsg = await json('JSON.stringify((document.getElementById("ysp-toast")||{}).textContent||"")');
    check('剪贴板为空时给提示且不导入任何东西',
      /剪贴板是空的/.test(emptyMsg) && (await ev('__yspUI.count()')) === nClip0,
      JSON.stringify(emptyMsg));

    // ② 单行网址 → 走 add（importUrl），收成一条源
    const CLIP_URL = 'https://clipboard-import.invalid/clip-one.m3u8';
    await ev(`__yspUI.clipResult(${JSON.stringify(CLIP_URL)})`);
    await sleep(3200);
    const nClip1 = await ev('__yspUI.count()');
    check('剪贴板里是单个网址 → 当成一条源收下',
      nClip1 === nClip0 + 1 &&
      (await json('JSON.stringify(__yspUI.urls())')).includes(CLIP_URL),
      `${nClip0} → ${nClip1}`);

    // ③ 多行 m3u 文本 → 走 addText（importText，不联网），整份导入
    const CLIP_M3U = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="剪贴板组",剪贴板台甲',
      'https://clipboard-import.invalid/a.m3u8',
      '#EXTINF:-1 group-title="剪贴板组",剪贴板台乙',
      'https://clipboard-import.invalid/b.m3u8',
    ].join('\n');
    await ev(`__yspUI.clipResult(${JSON.stringify(CLIP_M3U)})`);
    await sleep(1500);
    const stClip = await json(`JSON.stringify({
      n: __yspUI.count(), names: __yspUI.names(),
      groups: __yspUI.groups(), urls: __yspUI.urls()
    })`);
    check('剪贴板里是 m3u 文本 → 整份导入（不止一条）',
      stClip.n === nClip1 + 2, `${nClip1} → ${stClip.n}`);
    check('粘进来的台名和分组都对（分组名进了 tab）',
      stClip.names.includes('剪贴板台甲') && stClip.names.includes('剪贴板台乙')
      && stClip.groups.includes('剪贴板组'),
      stClip.groups.join('/'));
    check('文本分支不走网络（invalid 域名照样进列表，说明只解析不抓取）',
      stClip.urls.includes('https://clipboard-import.invalid/a.m3u8')
      && stClip.urls.includes('https://clipboard-import.invalid/b.m3u8'));

    // 收尾：清掉这三条，别污染后面的删除/镜像用例。
    // ⚠️ 清完必须把基准源放回去：后面「屏上键盘」段假设列表里已有可播的源
    //    （它自己只加 1 条），而「删除模式」要一个不是正在播的邻居当靶子。
    await ev('__yspUI.rpc("clear")');
    await sleep(1400);
    check('剪贴板测试导入的源已清干净',
      (await ev('__yspUI.count()')) === 0, `n=${await ev('__yspUI.count()')}`);
    // 逐条导入并逐条等：第二条（x36xhzz）是 master 清单，importUrl 要先抓一遍
    // 判断「是流还是清单」，两段一起发 + 死等 1.8 秒会偶发只落一条。
    for (const u of [BASE_URL, BASE_URL2]) {
      await ev(`__yspUI.rpc("add", "", ${JSON.stringify(u)})`);
      const want = (BASE_URL === u) ? 1 : 2;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        if ((await ev('__yspUI.count()')) >= want) break;
      }
    }
    check('剪贴板段收尾：基准源已复位（后面几节依赖列表非空）',
      (await ev('__yspUI.count()')) === 2, `n=${await ev('__yspUI.count()')}`);
  }

  /* ---------- 屏上键盘 ---------- */
  section('设备端：屏上键盘输入新源');
  await ev('__yspUI.closeManage()');
  await sleep(300);
  await ev('__yspUI.openManage()');
  await sleep(500);
  // 前置诊断：按键必须真的落到这一页上，否则后面全是误判
  const pre = await json(`JSON.stringify({
    mode: __yspUI.mode(), mg: __yspUI.isManageOpen(), idx: __yspUI.menuIndex(),
    pageFocus: document.hasFocus()
  })`);
  console.log('    · 键盘前置状态', JSON.stringify(pre), 'fg=', foregroundIsOurs());
  check('管理浮层确实开着（按键才有的放矢）', pre.mg === true && pre.mode === 'menu', JSON.stringify(pre));

  // 光标在第 0 项「局域网导入」，移到「屏上输入新源」。
  // ⚠️ v1.9 之后不能写死「下移一次」—— 中间插了「从剪贴板导入」，
  //    「屏上输入新源」的下标会随清单地址（刷新项）是否存在而变。
  //    一律用 menuLabels().indexOf 求下标，别再数格子。
  const kbIdx = (await json('JSON.stringify(__yspUI.menuLabels())')).indexOf('屏上输入新源');
  await ev(`(function(){ for(var i=0;i<${kbIdx};i++) __yspUI.key("DOWN"); return 1; })()`);
  await sleep(200);
  check(`下键把菜单光标移到「屏上输入新源」（下标 ${kbIdx}）`,
    (await ev('__yspUI.menuIndex()')) === kbIdx,
    'idx=' + await ev('__yspUI.menuIndex()'));
  await key(KEYS.OK);
  const kb1 = await json(`JSON.stringify({
    kb: __yspUI.isKbOpen(), st: __yspUI.keyboard(),
    keys: document.querySelectorAll('#mgCard .kb-key').length,
    fields: document.querySelectorAll('#mgCard .kb-field').length
  })`);
  check('打开屏上键盘', kb1.kb === true && kb1.fields === 2, JSON.stringify(kb1));
  // 4 行字母数字（14+12+12+12=50）+ 7 个功能键 = 57
  check('键盘按键渲染出来了（50 字母数字 + 7 功能键）', kb1.keys === 57,
    `keys=${kb1.keys} fields=${kb1.fields} kb=${kb1.kb}`);
  check('默认停在「地址」栏（URL 才是必填的）', kb1.kb === true && kb1.st.field === 1,
    'kb=' + kb1.kb + ' field=' + kb1.st.field);

  // 键盘机制走一遍：字符 → 空格 → 删除
  const beforeTxt = kb1.st.url;
  await key(KEYS.UP); await key(KEYS.UP);   // 从功能键行上到字母行
  await key(KEYS.OK);                       // 打一个字符
  const typed = (await json('JSON.stringify(__yspUI.keyboard())')).url;
  check('在键盘上按确认能输入字符', typed.length === beforeTxt.length + 1,
    JSON.stringify(beforeTxt) + ' → ' + JSON.stringify(typed));
  for (let i = 0; i < 6; i++) await key(KEYS.DOWN);   // 一路下到功能键行
  check('光标停在功能键行', (await json('JSON.stringify(__yspUI.keyboard())')).r === 4);
  await key(KEYS.OK);                       // 第 1 格 = 空格
  check('功能键「空格」可用', (await json('JSON.stringify(__yspUI.keyboard())')).url.endsWith(' '));
  await key(KEYS.RIGHT); await key(KEYS.OK); // 第 2 格 = 删除
  check('功能键「删除」可用',
    (await json('JSON.stringify(__yspUI.keyboard())')).url.length === typed.length);

  // 非法地址要被拦下
  await ev('__yspUI.rpc("add","测试","这不是地址")');
  await sleep(500);
  const badMsg = await json('JSON.stringify(__yspUI.keyboard().msg)');
  check('非法地址被拦下并给出原因', /http|认不出来|不能为空/.test(badMsg), JSON.stringify(badMsg));
  shot('c05_keyboard');
  await key(KEYS.BACK);   // 取消 → 回菜单

  // 合法的一条，走完整链路（页面 → Java 解析 → 落盘 → 推回）
  //
  // ⚠️ 1.3 起「加一条地址」不再只解析文本：Android 侧会先把这个地址抓一遍
  //    （判断它是一路流还是一份清单），所以这里必须留够网络往返的时间 ——
  //    早先那句 sleep(1000) 在「域名不存在、要等一次 DNS 失败」时偏紧。
  const n0 = await ev('__yspUI.count()');
  await ev('__yspUI.rpc("add","键盘加的台","https://keyboard-test.invalid/kb.m3u8")');
  await sleep(3000);
  const n1 = await ev('__yspUI.count()');
  check('屏上键盘添加一条能落盘', n1 === n0 + 1, `${n0} → ${n1}`);
  check('新源出现在源列表里（按 SRC 断言，不看面板可见性）',
    (await json('JSON.stringify(__yspUI.names())')).some(l => l.indexOf('键盘加的台') >= 0));

  /* ---------- 删除模式 ---------- */
  section('设备端：删除模式');
  await ev('__yspUI.closeManage()');
  await sleep(400);
  await ev('__yspUI.openManage()');
  await sleep(500);
  const items = await json('JSON.stringify(__yspUI.menuLabels())');
  const delIdx = items.indexOf('删除源');
  await ev(`(function(){ for(var i=0;i<${delIdx};i++) __yspUI.key("DOWN"); return 1; })()`);
  await sleep(200);
  check('光标停到「删除源」', (await ev('__yspUI.menuIndex()')) === delIdx);
  await ev('__yspUI.key("OK")');
  await sleep(700);
  const del1 = await json(`JSON.stringify({
    del: __yspUI.isDeleteMode(), panel: __yspTV.isPanelOpen(),
    marks: document.querySelectorAll('.tv-main-con-r-list-left > div.ysp-row[data-mark="✕"]').length,
    rows: document.querySelectorAll('.tv-main-con-r-list-left > div.ysp-row').length
  })`);
  check('进入删除模式且面板保持展开', del1.del === true && del1.panel === true);
  check('每一行都打上了 ✕ 标记', del1.marks === del1.rows && del1.rows > 0,
    `${del1.marks}/${del1.rows}`);
  shot('c06_delete_mode');

  const nBefore = await ev('__yspUI.count()');
  const urlsBefore = await json('JSON.stringify(__yspUI.urls())');
  // 光标进删除模式时停在「正在播放」那一行，不一定在第 0 行 ——
  // 所以按实际光标位置挑一个「不是正在播的」邻居当靶子，而不是想当然取第 2 行
  const cur = await ev('__yspTV.index()');
  const target = (cur + 1 < nBefore) ? cur + 1 : cur - 1;
  const victim = urlsBefore[target];
  const playingNow = await ev('__yspUI.playingUrl()');
  console.log(`    · 删除靶子 idx=${target} cur=${cur} victim=${victim}`);
  if (target !== cur) await ev(`__yspTV.move(${target - cur})`);
  await sleep(250);
  check('删除模式的光标没被 5 秒自动隐藏收掉（面板仍开着）',
    (await ev('__yspTV.isPanelOpen()')) === true);
  check('光标停在靶子上', (await ev('__yspTV.index()')) === target,
    `idx=${await ev('__yspTV.index()')} 期望 ${target}`);
  await ev('__yspUI.key("OK")');    // 删掉它
  await sleep(900);
  const nAfter = await ev('__yspUI.count()');
  const urlsAfter = await json('JSON.stringify(__yspUI.urls())');
  check('确认键删掉一条', nAfter === nBefore - 1, `${nBefore} → ${nAfter}`);
  check('删掉的正是光标指着的那条',
    urlsBefore.includes(victim) && !urlsAfter.includes(victim),
    `靶子在删前=${urlsBefore.includes(victim)} 在删后=${urlsAfter.includes(victim)}`);
  check('正在播的那条没被误删',
    !playingNow || urlsAfter.includes(playingNow),
    `playing=${playingNow}`);
  check('删除后 ✕ 标记数量跟着更新',
    (await ev('document.querySelectorAll(".tv-main-con-r-list-left > div.ysp-row[data-mark=\\"✕\\"]").length'))
    === nAfter);
  await ev('__yspUI.key("BACK")');  // 回菜单
  await sleep(600);
  check('返回键从删除模式回到菜单', (await ev('__yspUI.isManageOpen()')) === true);
  shot('c07_after_delete');

  /* ---------- 收尾：按键不应把应用搞崩 ---------- */
  /* ================================================================
     ⑪ 镜像自动顺延（v1.4）
     ================================================================
     为什么用人造数据（同名 + 设备本机 1 端口），而不是拿真清单里那些不通的台：
       真清单里哪几路是死的，每次抓都不一样（地址常带会过期的 token），
       拿它当断言对象就是抛硬币。
       这里要验的是【顺延这件事本身】：不通 → 自动换下一路 → 试满上限 → 才报失败。
       三步必须完全确定，所以三路全用 127.0.0.1:1（设备上立刻 ECONNREFUSED，
       这是 iptv_realworld_test 已经在用的同一个手法）。
     台名刻意写成三种写法，顺带验证「归一化之后才算同一个台」在设备上真的生效。
     ================================================================ */
  section('设备端：镜像自动顺延（同台多路全不通）');
  {
    // ⚠️ 前置：必须先把「源管理」浮层收掉，否则整节会假失败。
    //    上一节（删除模式）结束时光标停在菜单里，Java 侧的 manageOpen 是真的 ——
    //    而 CustomActivity 在浮层开着时【刻意】不做顺延（那是「我要接管」的信号）。
    //    实测就被这条骗过一次：三路顺延一条都没发生、看起来像功能没实现，
    //    实际上是守卫挡住了。所以这里把前置条件**断言出来**，
    //    而不是默默 closeManage —— 默默关掉的话，这条耦合就永远没人记得。
    await ev('__yspUI.closeManage()');
    await sleep(600);
    check('前置：源管理浮层已收起（浮层开着时设计上就不顺延）',
      (await json('JSON.stringify(__yspUI.isManageOpen())')) === false);

    /* ---- A/B 对照：同一路死源，唯一变量是「源管理浮层开没开」----
       为什么值得多花这十几秒：第一次跑这一节时，整节的顺延全部没发生，
       现场看起来和「功能根本没实现」一模一样 —— 真正的原因是上一节结束时
       浮层没关，而守卫当时一声不吭。所以这里不只补前置，还要把这条规则
       本身连同它的日志一起断言掉，免得下次再被同一件事骗第二次。 */
    {
      const GUARD = ['http://127.0.0.1:1/guard-1.m3u8', 'http://127.0.0.1:1/guard-2.m3u8'];
      const waitFor = async (re, ms) => {
        const t = Date.now();
        let s = '';
        while (Date.now() - t < ms) { await sleep(400); s = logcat(); if (re.test(s)) break; }
        return s;
      };
      const pick = async (u) => {
        await ev(`__yspUI.rpc("pick", ${JSON.stringify(u)})`);
      };
      for (const u of GUARD) {
        await ev(`__yspUI.rpc("add", "守卫台", ${JSON.stringify(u)})`);
        await sleep(1500);
      }

      // A：浮层开着 → 不许安静地换台
      await ev('__yspUI.openManage()');
      await sleep(800);
      adb('logcat', '-c');
      await pick(GUARD[0]);
      const lgA = await waitFor(/播放失败/, 40000);
      check('浮层开着时点一条死源：不安静地换台（顺延被守卫挡住）',
        /播放失败/.test(lgA) && !/镜像顺延 \d/.test(lgA),
        lgA.split('\n').filter(l => /镜像顺延|播放失败|浮层开着/.test(l))
           .map(l => l.replace(/^.*?YSPTV\s*:\s*/, '').trim()).join(' | ') || '（没有日志）');
      check('守卫挡掉时留下了一条能排障的日志（否则现场会误判成「功能没实现」）',
        /跳过镜像顺延/.test(lgA));

      // B：换成同一路死源，只是把浮层收掉 → 顺延必须立刻发生
      await ev('__yspUI.closeManage()');
      await sleep(800);
      adb('logcat', '-c');
      await pick(GUARD[0]);
      const lgB = await waitFor(/镜像顺延 \d/, 40000);
      // 日志里的分子是「马上要试第几路」，所以这里应该是 2/2（guard-2 是第 2 路）
      check('同一路死源，只是把浮层收掉了：顺延立刻发生（A/B 对照成立）',
        /镜像顺延 2\/2/.test(lgB),
        lgB.split('\n').filter(l => /镜像顺延/.test(l))
           .map(l => l.replace(/^.*?YSPTV\s*:\s*/, '').trim()).join(' | ') || '（没有顺延日志）');
      await waitFor(/播放失败/, 40000);   // 等这一轮走完，别和后面的用例搅在一起
    }

    const DEAD = ['http://127.0.0.1:1/mirror-1.m3u8',
                  'http://127.0.0.1:1/mirror-2.m3u8',
                  'http://127.0.0.1:1/mirror-3.m3u8'];
    // 归一化之后都是「镜像台」→ 必须被当成同一个台
    const NAMES = ['镜像台', '镜像-台', '镜像台 高清'];
    for (let i = 0; i < 3; i++) {
      await ev(`__yspUI.rpc("add", ${JSON.stringify(NAMES[i])}, ${JSON.stringify(DEAD[i])})`);
      await sleep(1500);
    }
    const s0 = await json(`JSON.stringify({ n: __yspUI.count(), urls: __yspUI.urls() })`);
    check('三种写法的同台地址都进了列表（归一化在这三种写法上生效）',
      DEAD.every(u => s0.urls.includes(u)),
      `列表里共 ${s0.n} 条，命中的：${s0.urls.filter(u => /127\.0\.0\.1:1\/mirror/.test(u)).length}/3`);

    adb('logcat', '-c');
    await ev(`__yspUI.rpc("pick", ${JSON.stringify(DEAD[0])})`);
    // 顺延是 250ms 一跳，三路全不通几秒内就该走完；
    // 留 60 秒余量是因为每一路都可能退化成 15 秒起播看门狗（虽然 1 端口是立刻拒绝）
    let lg = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      await sleep(500);
      lg = logcat();
      if (/播放失败/.test(lg)) break;
    }
    const strip = s => s.replace(/^.*?YSPTV\s*:\s*/, '').trim();
    const hops = lg.split('\n').filter(l => /镜像顺延/.test(l)).map(strip);
    const fails = lg.split('\n').filter(l => /播放失败/.test(l)).map(strip);

    check('第 1 路不通 → 自动跳到第 2 路', /镜像顺延 2\/3/.test(lg),
      hops.join(' | ') || '（没有出现任何顺延日志）');
    check('第 2 路不通 → 自动跳到第 3 路', /镜像顺延 3\/3/.test(lg));
    check('顺延只在同一个台内部跳（跳的全部是那三路地址）',
      hops.length > 0 && hops.every(l => /mirror-\d\.m3u8/.test(l)), hops.join(' | '));
    check('试满上限才报失败，而且只报一次', fails.length === 1,
      `播放失败 ${fails.length} 次：${fails.join(' | ')}`);
    check('失败文案说明了「同一个台试过几路」',
      /同台 3 路，本轮已试 3 路/.test(lg), fails[0] || '');

    const bads = await json('JSON.stringify(__yspUI.badUrls())');
    check('三路死地址都被打上失败标记（列表里会变暗 + ⚠）',
      DEAD.every(u => bads.includes(u)), `badUrls ${bads.length} 条`);

    /* ---- 匿名源不许互相顺延（这条规则是 §18 那个守卫成立的前提） ---- */
    const ANON = ['http://127.0.0.1:1/anon-a.m3u8', 'http://127.0.0.1:1/anon-b.m3u8'];
    for (const u of ANON) {
      await ev(`__yspUI.rpc("add", "", ${JSON.stringify(u)})`);
      await sleep(1500);
    }
    const s1 = await json('JSON.stringify(__yspUI.urls())');
    check('两条匿名源都进了列表', ANON.every(u => s1.includes(u)),
      `命中 ${ANON.filter(u => s1.includes(u)).length}/2`);

    adb('logcat', '-c');
    await ev(`__yspUI.rpc("pick", ${JSON.stringify(ANON[0])})`);
    let lg2 = '';
    const t1 = Date.now();
    while (Date.now() - t1 < 40000) {
      await sleep(500);
      lg2 = logcat();
      if (/播放失败/.test(lg2)) break;
    }
    check('没有台名的源播不通时【不会】去试别的源（否则会把互不相干的地址当镜像）',
      /播放失败/.test(lg2) && !/镜像顺延/.test(lg2),
      lg2.split('\n').filter(l => /镜像顺延|播放失败/.test(l)).map(strip).join(' | ') || '（没有日志）');
    const bads2 = await json('JSON.stringify(__yspUI.badUrls())');
    check('匿名源失败只标记它自己，没有牵连另一条',
      bads2.includes(ANON[0]) && !bads2.includes(ANON[1]),
      `badUrls: ${bads2.filter(u => /anon/.test(u)).join(' ')}`);

    /* ---- 收尾：清成零源（v1.9 没有示例源可恢复） ---- */
    await ev('__yspUI.rpc("clear")');
    await sleep(1400);
    const snM = await json('JSON.stringify({ n: __yspUI.count() })');
    check('收尾：镜像测试用的源已清掉', snM.n === 0 &&
      !(await json('JSON.stringify(__yspUI.urls())')).some(u => /127\.0\.0\.1:1/.test(u)),
      `n=${snM.n}`);
  }

  section('设备端：退出与健壮性');
  // ⚠️ 返回键是【分层退】的：键盘 → 源管理浮层 → 选台面板 → 才轮到 Activity。
  //    只按两次是不够的 —— 「第一次返回」很可能只是把面板收起来，
  //    那一次并不会走到 Activity 的「再按一次退出」倒计时上。
  //    所以先把各层显式收干净，再验两次返回退出。
  await ev('__yspUI.closeManage()');
  await ev('(function(){ try { window.__yspTV.closePanel(); } catch(e){} return 1; })()');
  await sleep(600);
  const collapsed = await json(`JSON.stringify({
    mg: __yspUI.isManageOpen(), kb: __yspUI.isKbOpen(), panel: __yspTV.isPanelOpen(),
    mode: __yspUI.mode()
  })`);
  check('收尾前各层已收起（两次返回才轮到 Activity）',
    collapsed.mg === false && collapsed.kb === false && collapsed.panel === false,
    JSON.stringify(collapsed));

  await key(KEYS.BACK);             // 第 1 次：进入「再按一次退出」倒计时
  const fgAfter1 = foregroundIsOurs();
  check('第一次返回只是提示，不直接退出', fgAfter1 !== null, '前台=' + JSON.stringify(fgAfter1));

  await key(KEYS.BACK);             // 第 2 次：退出
  await sleep(1500);
  // ⚠️ 这里不能用 pidof 判「退出」。实测：finish() 之后 Activity 确实没了，
  //    但进程会被系统缓存住（带 WebView 的进程尤其赖着不走），pidof 照样有值 ——
  //    用 pidof 会得到一个「永远失败」的假断言。
  //    用户看得见的「退出」= 回到桌面，所以判前台窗口归不归我们。
  const fgAfter2 = foregroundIsOurs();
  check('连按两次返回退出（Activity 已退出，前台回到桌面）',
    fgAfter2 === null,
    '前台=' + JSON.stringify(fgAfter2) + '（进程可能仍在被系统缓存，这不算没退出）');

  const crash = sh(`"${ADB}" -s ${SERIAL} logcat -d -s AndroidRuntime:E`);
  check('全程无崩溃', !new RegExp(PKG.replace(/\./g, '\\.')).test(crash),
    (crash.match(/FATAL EXCEPTION[\s\S]{0,200}/) || [''])[0].split('\n')[0]);
  const jsErr = sh(`"${ADB}" -s ${SERIAL} logcat -d -s YSPTV:V | grep -c "yspBridge 调用失败"`);
  check('页面里没有桥调用失败', +jsErr === 0, `count=${jsErr}`);
}

/* ============================================================
   跑
   ============================================================ */
staticChecks();
hostUnitTests();
if (MODE !== 'static') {
  try { await deviceChecks(); }
  catch (e) { check('设备段执行完成', false, String(e && e.message || e)); }
}

section('汇总');
const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log(`  ${pass} 过 / ${fail} 失败   （截图在 ${SHOTS}）`);
if (fail) {
  console.log('\n失败项：');
  for (const r of results.filter(x => !x.ok)) console.log('  ❌ ' + r.name + (r.detail ? '   — ' + r.detail : ''));
  process.exit(1);
}
