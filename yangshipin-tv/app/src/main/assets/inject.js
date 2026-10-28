/* ============================================================
   央视频 TV —— 交互注入脚本

   交互模型：
     · 面板收起（默认）  上/下键 = 直接换到上/下一台，并弹出频道名气泡
     · 按确认键          面板从【左侧】滑入，光标落在正在播放的那一路
     · 面板展开          上/下 = 移动光标（不换台）；确认 = 选中该台并收起面板
                        左/右 = 切换 CCTV / 卫视；5 秒无操作自动隐藏
     · 面板展开时左/右切 tab、上下移动，都会重置自动隐藏倒计时
     · 面板顶部常驻一行「自定义源」：光标在第 0 台再按一次【上】就到它，
                        确认 = 打开自定义源（原生播放器 + m3u8 管理）

   ⚠️ 为什么必须有一个看得见的「自定义源」入口：
      Android TV 桌面上本来有一张「自定义源」卡片，但 Google TV 的桌面会把
      同一包名的多个 LEANBACK_LAUNCHER 入口**按包聚合成一张卡片**，那张卡片
      永远不出现；另外两个入口（长按菜单键 700ms、蓝键）又都是「要按对键才
      生效」的隐藏操作。结果就是功能完全正常、用户却找不到。
      所以入口必须在【打开面板就看得到】的位置，而且遥控器能走到。

   ⚠️ 核心认知：频道容器 .tv-main-con-r-list-left 里同时装着两份名单
      - .tv-main-con-r-list-left-imga  → 央视频道（40 个）
      - .tv-main-con-r-list-left-imgb  → 卫视频道（33 个）
      站点用 display:none 隐藏非活动那份。所以：
      ▶ rows() 必须过滤出「真正可见」的行，否则上下键会换到隐藏项。

   Android 侧通过 evaluateJavascript 调用 window.__yspTV.*
   ============================================================ */
(function () {
  'use strict';
  if (window.__yspTV) return;

  var LIST_SEL = '.tv-main-con-r-list-left';
  var TAB_SEL  = '.tv-main-con-r-tab';
  var ROOT     = '.tv-main-con';
  var FOCUS    = 'ysp-focus';
  var AUTO_HIDE_MS = 5000;

  /* 面板顶部的「自定义源」入口。它不是频道行，所以【不放进 LIST_SEL】——
     放进去会被 rows() 当成第 0 个频道，换台 / 删除 / 计数全乱。 */
  var ENTRY_ID   = 'ysp-custom-entry';
  var ENTRY_TEXT = '自定义源 · 添加你自己的直播源';   // 主界面：打开 CustomActivity
  var ENTRY_TEXT_ADD = '＋ 添加自定义源';             // 自定义源页：打开本页的「源管理」

  var idx = 0;                    // 面板光标（频道下标）
  var onEntry = false;            // 光标是否停在「自定义源」入口上
  var panelOpen = false;
  var hideTimer = null;
  var toastTimer = null;
  var holdToastTimer = null;

  // ------------------------------------------------------------------
  // 换台节流（v1.7）
  // ------------------------------------------------------------------
  /* 为什么要节流：站点自研的 WASM HLS 播放器（hls.cmg.js）换台时走
     detachMedia → moduleActive，高频连按会读到一个 null 的 .length 直接抛
     TypeError，把「卸旧源 → 挂新源」这个序列拦腰截断 —— video.src 已经被清掉，
     新源永远挂不上，播放器就此永久死掉（readyState 0 / networkState 0，
     再点任意一行也救不回来，只有 location.reload() 能复活）。
     实测（模拟器 API 34，见 tools/wedge_repro.mjs）：
       · 单次换台、间隔 2.5s、连换 10 次   → 0 次死亡
       · 120ms 连按 6 次                   → 4 轮里死 2 轮，死亡轮次全是 6 条
                                               detachMedia 报错，存活轮 0–1 条
     对策：两次「发车」之间留够站点播放器走完整个卸/挂序列的时间
     （实测首帧 1.3–1.6s，取 1.5s），间隔内后续按键只更新目标、不叠发，
     到点直接落到最后想要的那一台。单次按键不受影响（阀门只对上一次发车生效）。 */
  var SWITCH_GAP_MS = 1500;
  var switchGateUntil = 0;         // 下次允许发车的时刻（Date.now() 基准）
  var switchTimer = 0;             // 待发车的定时器 id
  var switchWant = -1;             // 合并后的目标下标，-1 = 无待发

  /* ---- 防抖：连续按上下键时先只动光标，停下来再换（v1.12）----
     ⚠️ 为什么要它、为什么不直接用「固定延迟」：
       固定延迟（按下去等 1 秒再换）在实测里【手感更差】：
         阀门   0ms → 停下按键到出画 1383ms
         阀门 300ms →              1154ms
         阀门 600ms →              1694ms
         阀门1000ms →              1873ms
       也就是说，固定延迟把用户「停下按键 → 看到画面」的等待又拉长了半秒以上，
       而它换来的好处（少切几台）用防抖能拿到、且不额外加延迟。

       防抖的语义更贴合手指：用户按住连续按的时候，意图本来就在「翻」而不是
       「跳到某一台」，所以过程中只移光标（连气泡会跟着走，能看见在翻），
       停手 250ms 后落到最后一台。中间那几台一次都不会去碰站点播放器 ——
       卡顿的真正来源（反复 detach/mount 站点那个 WASM 播放器）也就没了。

     为什么是 250ms：比常见的 200~300ms 略偏大一点 ——
       站点自己出画就要1.3~1.6s，250ms 在「等得值」和「不显得迟钝」之间。
       再大就接近「按了没反应」了（遥控器连按的人尤其敏感）。*/
  var SWITCH_DEBOUNCE_MS = 250;
  var switchDebTimer = 0;          // 防抖定时器 id
  var debWant = -1;                // 防抖挂起时的目标下标（move 的续算基点）

  /* ---- 阀门提前解锁（v1.13）----
     老逻辑是「排队之后傻等满 SWITCH_GAP_MS」。问题是站点自己的换台只要
     1.3–1.6s，而阀门压了 1.5s —— 用户正常地一台一台往下翻时，第二次按键
     经常要白等几百毫秒，那正是"反应慢"的来源之一。
     改成：一旦站点播放器真的出画（readyState>=3 且在走、网络空闲），
     就说明上一次「卸旧源 → 挂新源」已经走完，立刻发下一趟，不必等满。

     ⚠️ 两条保险，防止把 v1.7 修好的"播放器被打死"放回来：
       ① 硬下限 floor = 60% × SWITCH_GAP_MS。就绪判得再快，两次碰站点
          播放器之间也至少隔这么久（复现死亡的连按间隔是 120ms，差 5 倍以上）。
       ② 到点 deadline 仍然照发 —— 判不出就绪时行为与老逻辑完全一致，
          不会把"永远等不到出画"变成死等。 */
  var EARLY_UNLOCK_MS = 100;       // 就绪轮询间隔
  var unlockTimer = 0;

  // ------------------------------------------------------------------
  // 基础工具
  // ------------------------------------------------------------------

  /* 只取可见行：display:none 的 offsetParent 为 null */
  function rows() {
    var l = document.querySelector(LIST_SEL);
    if (!l) return [];
    return Array.prototype.slice.call(l.children).filter(function (r) {
      if (r.offsetParent === null) return false;
      var b = r.getBoundingClientRect();
      return b.height > 1 && b.width > 1;
    });
  }

  function clamp(i, n) { return i < 0 ? 0 : (i >= n ? n - 1 : i); }

  function root() { return document.querySelector(ROOT); }

  // ------------------------------------------------------------------
  // 面板顶部的「自定义源」入口
  // ------------------------------------------------------------------

  function entryEl() { return document.getElementById(ENTRY_ID); }

  /* 入口在两种页面都挂，但【动作】不同：
     · 主界面（有 yspBridge）     → 打开 CustomActivity，文案「自定义源 · 添加你自己的直播源」
     · 自定义源页（有 yspCustom） → 打开本页的「源管理」浮层，文案「＋ 添加自定义源」

     ⚠️ 自定义源页也复用 inject.js（见 custom.html 顶部的注释：它故意造出一样的
        DOM 形状，好让面板观感/滚动/手势全部复用）。1.5.1 时那边【不】挂入口：
        那行的动作是开 CustomActivity，在自定义源页里再开一次就是自指，
        而且它注册的是 yspCustom 桥、没有 yspBridge，点了只会弹「桥接缺失」。
        1.8 把动作换成「打开源管理」之后就不再是自指了 —— 自定义源页因此也有了一个
        看得见的添加入口（用户原话：「没有添加自定义源的位置」，以前只能靠菜单键）。
     用「桥在不在」来区分，比判 URL 更本质：桥不在 = 这个 WebView 打不开
        CustomActivity，入口的动作就只能是源管理。 */
  function entryIsAdd() {
    return !(window.yspBridge && typeof window.yspBridge.openCustom === 'function')
        && !!window.yspCustom;
  }

  function entryWanted() {
    if (window.yspBridge && typeof window.yspBridge.openCustom === 'function') return true;
    return !!window.yspCustom;      // 自定义源页：挂「＋ 添加自定义源」
  }

  function entryText() {
    return entryIsAdd() ? ENTRY_TEXT_ADD : ENTRY_TEXT;
  }

  /* 把入口钉进面板 DOM（幂等）。
     站点首屏会重渲染面板，入口可能被连根拔掉，所以每次 paint 都重新确认一次。
     插在 tab 与频道列表之间：不在 LIST_SEL 内 → rows() / idx 完全不受影响。 */
  function ensureEntry() {
    if (!entryWanted()) return null;
    var panel = document.querySelector('.tv-main-con-r');
    if (!panel) return null;
    var el = entryEl();
    if (el && el.parentNode === panel) return el;
    if (el && el.parentNode) el.parentNode.removeChild(el);   // 被站点搬到别处了，先摘下来
    el = document.createElement('div');
    el.id = ENTRY_ID;
    el.textContent = entryText();
    if (entryIsAdd()) el.className = 'ysp-entry-add';   // 给 custom.css 一个抓手（底色要压深，见那里）
    var list = panel.querySelector('.tv-main-con-r-list');
    if (list && list.parentNode === panel) panel.insertBefore(el, list);
    else panel.appendChild(el);
    return el;
  }

  /* 入口的动作：
     · 主界面     → 经 yspBridge 让 Android 侧打开 CustomActivity
     · 自定义源页 → 打开本页的「源管理」浮层（__yspUI.openManage，由 custom.js 提供）
     两条路都不通时返回 false，调用方会提示。 */
  function openCustom() {
    try {
      if (window.yspBridge && typeof window.yspBridge.openCustom === 'function') {
        window.yspBridge.openCustom();
        return true;
      }
    } catch (e) {}
    try {
      if (window.__yspUI && typeof window.__yspUI.openManage === 'function') {
        window.__yspUI.openManage();
        return true;
      }
    } catch (e) {}
    return false;
  }

  /* 站点维护的「正在播放」行下标；所在 tab 不是当前 tab 时返回 -1
     rs 可传入已有的行快照 —— 一次按键里 rows() 要被问好几遍，
     每遍都要对约 40 个可见行做 getBoundingClientRect（强制重排）。 */
  function playingIndex(rs) {
    rs = rs || rows();
    for (var i = 0; i < rs.length; i++) {
      if (rs[i].classList.contains('tvSelect')) return i;
    }
    return -1;
  }

  function labelAt(i, rs) {
    rs = rs || rows();
    if (!rs.length) return '';
    var r = rs[clamp(i, rs.length)];
    return (r.innerText || '').trim().replace(/\s+/g, ' ');
  }

  /* 站点播放器是不是真的出画了。
     换台时站点会卸掉旧 video、挂新的，整个重 sourcing 期间 readyState 掉到 0，
     所以这个判据天然就把"还在换"排除了。用于：
       · 阀门提前解锁（见上面 EARLY_UNLOCK_MS 那段）
       · 换台气泡守到出画再撤（见 showToastHold） */
  function playerSettled() {
    var v = document.querySelector('.tv-main-con-l video');
    if (!v) return false;
    if (v.readyState < 3) return false;          // HAVE_ENOUGH_DATA
    if (v.paused) return false;
    if (v.networkState !== 1) return false;      // NETWORK_IDLE：没有在起播/在缓冲
    return v.currentTime > 0 && v.videoWidth > 0;
  }

  /* 真实点击：部分处理绑在 mousedown/mouseup 上，仅 click() 不触发 */
  function fireClick(el) {
    if (!el) return false;
    try {
      ['mousedown', 'mouseup', 'click'].forEach(function (n) {
        el.dispatchEvent(new MouseEvent(n, {
          bubbles: true, cancelable: true, view: window, button: 0
        }));
      });
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
    return true;
  }

  function activateAt(i) {
    var rs = rows();
    if (!rs.length) return false;
    return fireClick(rs[clamp(i, rs.length)]);
  }

  /* ---- 换台发车（带节流）----
     immediate=true 用于「用户明确选定」的路径（确认键选中某行），可以插队；
     其余一律走阀门。 */
  function fireSwitch(target, immediate) {
    switchWant = -1;
    if (switchTimer) { clearTimeout(switchTimer); switchTimer = 0; }
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = 0; }
    if (target < 0) return false;
    if (!immediate) {
      var wait = switchGateUntil - Date.now();
      if (wait > 0) {
        switchWant = target;
        switchTimer = setTimeout(function () { fireSwitch(switchWant, true); }, wait);
        armEarlyUnlock(wait);   // 一出画就提前发
        return true;
      }
    }
    switchGateUntil = Date.now() + SWITCH_GAP_MS;
    return activateAt(target);
  }

  /* 排队期间盯着站点播放器：一出画就把待发车立刻发掉。
     fireSwitch(t, true) 自己会清掉上面那个"到点发车"的 switchTimer，
     所以两条路只会中一条，不会叠发。 */
  function armEarlyUnlock(wait) {
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = 0; }
    var armedAt = Date.now();
    var deadline = armedAt + wait;
    var floor = Math.round(SWITCH_GAP_MS * 0.6);   // 硬下限，见上面注释里的保险①
    var tick = function () {
      if (switchWant < 0) { unlockTimer = 0; return; }     // 单被撤了（按回当前台）
      var left = deadline - Date.now();
      if (left <= 0 || (Date.now() - armedAt >= floor && playerSettled())) {
        unlockTimer = 0;
        var t = switchWant;
        fireSwitch(t, true);
        return;
      }
      unlockTimer = setTimeout(tick, EARLY_UNLOCK_MS);
    };
    unlockTimer = setTimeout(tick, EARLY_UNLOCK_MS);
  }

  /* 取消待发车（目标已经等价于当前播放时调用，见 move()） */
  function cancelSwitch() {
    if (switchTimer) { clearTimeout(switchTimer); switchTimer = 0; }
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = 0; }
    switchWant = -1;
    // ⚠️ 防抖也要一起撤：不然「按回当前正在播的那台」之后，
    //    那个还挂着的防抖定时器会在 250ms 后照旧发一趟车 ——
    //    用户明明说了「不换」，却又被换走，体验上比不防抖更莫名其妙。
    clearDebounce();
  }

  /* 把待发车立刻发掉：用户做了别的明确动作（确认键、切 tab）时用，
     避免一个"迟到"的换台在用户干别的事情时突然插进来。 */
  function flushSwitch() {
    var t = switchWant;
    if (switchTimer) { clearTimeout(switchTimer); switchTimer = 0; }
    if (unlockTimer) { clearTimeout(unlockTimer); unlockTimer = 0; }
    switchWant = -1;
    if (t >= 0) { switchGateUntil = Date.now() + SWITCH_GAP_MS; activateAt(t); }
  }

  // ------------------------------------------------------------------
  // 提示气泡
  // ------------------------------------------------------------------

  function toastEl() {
    var el = document.getElementById('ysp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ysp-toast';
      // ⚠️ 挂 body，不要挂 #app。
      // 清场规则是 `body > *:not(#app):not(#ysp-toast){display:none}` ——
      // 已经放行了 #ysp-toast，所以挂 body 不会被隐藏；
      // 而站点首屏会把 #app 的内容重渲染一遍，挂里面会被连带清掉
      // （现象很隐蔽：localStorage 标记已置位，气泡却从没出现过）。
      var host = document.body || document.querySelector('#app') || document.documentElement;
      host.appendChild(el);
    }
    return el;
  }

  function hideToast() {
    var el = document.getElementById('ysp-toast');
    if (el) el.classList.remove('show');
  }

  function showToast(text) {
    if (!text) return;
    var el = toastEl();
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    clearTimeout(holdToastTimer);
    toastTimer = setTimeout(hideToast, 1600);
  }

  /* 换台专用的气泡：守到真的出画再撤（v1.13）。
     站点换台要 1.3–1.6s，而普通气泡 1.6s 就撤 —— 于是「提示没了、画面还是
     上一台」，中间那段空窗用户读起来就是"卡住了"。守到 playerSettled()
     或最多 cap，再留 900ms 让人看清台名。 */
  function showToastHold(text, maxMs) {
    if (!text) return;
    var el = toastEl();
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    clearTimeout(holdToastTimer);
    /* 页面上根本没有 <video>（inject.js 被自定义源页复用，那边是原生播放器）
       → 没有"出画"可等，按普通气泡的节奏撤，别白等满 cap。 */
    if (!document.querySelector('.tv-main-con-l video')) {
      toastTimer = setTimeout(hideToast, 1600);
      return;
    }
    var t0 = Date.now();
    var cap = maxMs || 6000;
    (function wait() {
      if (playerSettled() || Date.now() - t0 > cap) {
        toastTimer = setTimeout(hideToast, 900);
        return;
      }
      holdToastTimer = setTimeout(wait, 120);
    })();
  }

  // ------------------------------------------------------------------
  // 光标绘制
  // ------------------------------------------------------------------

  function clearFocus() {
    /* ⚠️ 必须「先判断有没有、再摘」。
       DOMTokenList.remove() 按规范会**无条件走一遍 update steps**，
       也就是即使这个 class 本来就不在，也会把 class 属性写一遍 ——
       于是每次 clearFocus 都给 40 行各记一条 attribute 变更。
       平时无所谓（重画完紧接着会给光标行 add 回去，观察者看到有焦点就停了），
       但光标停在「自定义源」入口上时，频道行【永远没有焦点】，
       观察者就会陷入 paint → 写 class → 观察者 → paint … 的无限微任务循环，
       主线程再也回不到事件循环（实测：渲染进程 107% CPU 空转，
       CDP 的 Runtime.evaluate 永不回包，看起来像「App 崩了」）。
       先 contains() 判断一下，就把这条链从根上掐断。 */
    var l = document.querySelector(LIST_SEL);
    if (l) {
      Array.prototype.slice.call(l.children).forEach(function (r) {
        if (r.classList.contains(FOCUS)) r.classList.remove(FOCUS);
      });
    }
    var e = entryEl();
    if (e && e.classList.contains(FOCUS)) e.classList.remove(FOCUS);
  }

  // ------------------------------------------------------------------
  // 行高自适应 + 整行对齐滚动
  //
  // 要解决的是两个「半行」：
  //   ① 列表可视高 ÷ 行高 除不尽 → 底边永远露半行
  //   ② scrollIntoView({block:'center'}) 会把滚动位置落在行中间 → 顶边露半行
  // 做法：把 --row-h 重算成「可视高 ÷ 整数行数」，再把 scrollTop 对齐到行高的整数倍。
  // ------------------------------------------------------------------

  var ROWVAR = '--row-h';
  var lastRowH = 0;

  function fitRows() {
    var l = document.querySelector(LIST_SEL);
    if (!l) return;
    var rs = rows();
    if (!rs.length) return;
    var viewH = l.clientHeight;                        // CSS 里 padding 已置 0
    var h0 = rs[0].getBoundingClientRect().height;
    if (!viewH || !h0) return;
    var n = Math.max(3, Math.round(viewH / h0));       // 一屏正好装 n 行
    var rowH = viewH / n;
    // 收敛性：设成 viewH/n 后再算一次，n 不变 → 值不变，不会来回抖
    if (Math.abs(rowH - lastRowH) > 0.05) {
      lastRowH = rowH;
      document.documentElement.style.setProperty(ROWVAR, rowH.toFixed(3) + 'px');
    }
  }

  function scrollToRow(i) {
    var l = document.querySelector(LIST_SEL);
    var rs = rows();
    if (!l || !rs.length) return;
    i = clamp(i, rs.length);
    var lb = l.getBoundingClientRect();
    var rowH = rs[0].getBoundingClientRect().height;
    var viewH = l.clientHeight;
    if (!rowH || !viewH) return;

    // base = 行 0 在滚动内容坐标系里的偏移。
    // 不假设它是 0（padding / 边框 / 站点自身 margin 都会让它偏移），实测出来更稳：
    // 滚动过程中 scrollTop 增加多少，行 0 的视口位置就上移多少 → base 恒定。
    var base = l.scrollTop + (rs[0].getBoundingClientRect().top - lb.top);

    var per = Math.max(1, Math.floor(viewH / rowH + 0.001));   // 一屏能放下的整行数
    var maxTop = Math.max(0, rs.length - per);
    // 光标行尽量居中
    var top = i - Math.floor((per - 1) / 2);
    top = Math.max(0, Math.min(top, maxTop));

    var want = base + top * rowH;                      // 对齐到整行 → 顶边不留半行
    var maxScroll = Math.max(0, l.scrollHeight - viewH);
    want = Math.max(0, Math.min(want, maxScroll));
    if (Math.abs(l.scrollTop - want) > 0.5) l.scrollTop = want;
  }

  function paint(scroll) {
    var rs = rows();
    clearFocus();
    // 入口常驻：不管此刻有没有频道行，都要先保证它挂在面板上
    var e = ensureEntry();
    if (onEntry) {
      if (e) { e.classList.add(FOCUS); return; }   // 光标在入口上：不动频道列表、不动滚动
      onEntry = false;                             // 入口没了（换了页面）→ 落回频道
    }
    if (!rs.length) return;
    idx = clamp(idx, rs.length);
    var cur = rs[idx];
    cur.classList.add(FOCUS);
    if (scroll !== false) {
      fitRows();          // 先定行高（会触发强制重排）
      scrollToRow(idx);   // 再按新行高对齐滚动
    }
  }

  // ------------------------------------------------------------------
  // 面板开合 + 自动隐藏
  // ------------------------------------------------------------------

  function armAutoHide() {
    clearTimeout(hideTimer);
    if (!panelOpen) return;
    hideTimer = setTimeout(function () { closePanel(); }, AUTO_HIDE_MS);
  }

  /* 把面板开合状态同步给 Android 端（yspBridge 是 MainActivity 注册的极简 JS 桥）。
     返回键要靠它决定「收起面板」还是「进入退出倒计时」。 */
  function notifyPanel() {
    try {
      if (window.yspBridge && typeof window.yspBridge.onPanel === 'function') {
        window.yspBridge.onPanel(panelOpen);
      }
    } catch (e) {}
  }

  function openPanel() {
    var r = root();
    if (!r) return false;
    var p = playingIndex();
    if (p >= 0) idx = p;
    else if (!rows().length) return false;
    onEntry = false;                 // 每次开面板都从「正在播放的那台」起，不留在入口上
    panelOpen = true;
    r.classList.add('ysp-panel-open');
    paint(true);
    armAutoHide();
    notifyPanel();
    return true;
  }

  function closePanel() {
    var r = root();
    panelOpen = false;
    onEntry = false;                 // 面板都收了，光标不该还停在入口上
    clearTimeout(hideTimer);
    hideTimer = null;
    if (r) r.classList.remove('ysp-panel-open');
    notifyPanel();
    return true;
  }

  function togglePanel(force) {
    var want = (typeof force === 'boolean') ? force : !panelOpen;
    return want ? openPanel() : closePanel();
  }

  function isPanelOpen() { return panelOpen; }

  // ------------------------------------------------------------------
  // 对外动作
  // ------------------------------------------------------------------

  /* 上 / 下键 */
  function move(d) {
    var rs = rows();
    if (!rs.length) return idx;

    // --- 面板展开：移动光标，不换台 ---
    if (panelOpen) {
      /* 入口是列表【上方】额外的一个位置，只在「已在第 0 台、再往上按一次」
         时才进去。
         ⚠️ 条件必须精确到 d === -1（单步上键），不能写成 d < 0：
            custom.js 的 resetCursor(toTop) 用 move(-9999) 回顶，光标本就在第 0 行时
            会被误判成「到顶了又按一次上」→ 粘在入口上下不来，切分组/导入后光标全跑错。
            （device_test 有一条「大跨度回顶不误进入口」正是盯这个，只是主页那边
             move(-99) 之前 idx 恰好不是 0，一直没暴露；自定义源页 1.8 挂了入口之后，
             这条就从「潜在」变成「天天踩」。） */
      if (onEntry) {
        if (d > 0) { onEntry = false; idx = 0; }        // 往下 = 回到第 0 台
      } else if (d === -1 && idx === 0 && entryEl()) {
        onEntry = true;
      } else {
        idx = clamp(idx + d, rs.length);
      }
      paint(true);
      armAutoHide();
      return onEntry ? -1 : idx;                        // -1 = 光标在入口上
    }

    // --- 面板收起：直接换台 ---
    /* ⚠️ 续算的基点：必须从「我们的意图」续，不能从 playingIndex() 续 ——
       后者是站点 DOM 的状态，比我们的意图滞后（车还没发，站点还停在旧台），
       用它当基点会把连按的位移全部吞掉。

       ⚠️ 防抖加进来之后这里多了一个坑：防抖挂起期间 switchWant 一直是 -1
       （车还没进阀门），所以【只认 switchWant 是不够的】——
       那样连按 5 次，每次都从滞后的 playingIndex() 重算，位移会被吃掉 4 次，
       表现为「按 5 下只换了 1 台」（实测 idx 停在 from+1）。
       所以「意图」有两个来源：阀门里的 switchWant 和防抖里的 debWant，
       谁有值就从谁续。 */
    var cur = playingIndex(rs);
    var intend = (switchWant >= 0) ? switchWant
               : (switchDebTimer && debWant >= 0) ? debWant
               : -1;
    var target;
    if (intend >= 0) target = clamp(intend + d, rs.length);
    else if (cur < 0) target = (d > 0) ? 0 : rs.length - 1;   // 当前 tab 没有在播的行，落到首/末台
    else target = clamp(cur + d, rs.length);

    idx = target;
    /* 面板收起时画光标没有任何可见效果（整个面板被 translateX(-101%) 挪出屏幕），
       却要 clearFocus() 扫 40 行 + ensureEntry() 查一次 DOM，纯白费。
       开面板时 openPanel() 会 paint(true) 补上，所以收起态直接跳过。
       另外上面 rows() 只算了一遍就传下去 —— 早先这一趟按键要算 4 次
       （move / playingIndex / labelAt / paint），每遍都是一次强制重排。 */
    if (panelOpen) paint(true);
    /* 气泡守到出画：见 showToastHold 的注释 */
    showToastHold(labelAt(target, rs));
    /* 按回了当前正在播的那一台 → 撤掉待发车，别做无用功（也少惊动站点播放器） */
    if (target === cur) { cancelSwitch(); clearDebounce(); return idx; }
    /* 连续按 → 只排一个防抖，不再每按一次就发一趟车。
       fireSwitch 自身的阀门仍然生效（它是给「确认键选中」等明确路径兜底的），
       两条机制不冲突：阀门管「多久能发一趟」，防抖管「按键停了才发」。*/
    debounceSwitch(target);
    return idx;
  }

  /** 延迟到「按键停下来」才换台。连续按只会重置这一个定时器。 */
  function debounceSwitch(target) {
    if (switchDebTimer) clearTimeout(switchDebTimer);
    debWant = target;
    switchDebTimer = setTimeout(function () {
      switchDebTimer = 0;
      var t = debWant;
      debWant = -1;
      fireSwitch(t);
    }, SWITCH_DEBOUNCE_MS);
  }

  function clearDebounce() {
    if (switchDebTimer) { clearTimeout(switchDebTimer); switchDebTimer = 0; }
    debWant = -1;
  }

  /* 确认键：收起 → 弹出面板；展开 → 选中并收起（光标在入口上 → 打开自定义源） */
  function activate() {
    if (!panelOpen) return openPanel();
    if (onEntry) {
      var went = openCustom();
      closePanel();
      onEntry = false;
      if (!went) showToast(entryIsAdd() ? '打不开源管理' : '自定义源不可用（本页桥接缺失）');
      return went;
    }
    var name = labelAt(idx);
    var ok = fireSwitch(idx);          // 同样过阀门：面板刚收起时可能还有车在途中
    closePanel();
    showToastHold(name);               // 同样是换台，气泡也守到出画
    return ok;
  }

  function tabs() {
    return Array.prototype.slice.call(
      document.querySelectorAll(TAB_SEL + ' > .tv-main-con-r-tab-img'));
  }

  /* 切换 CCTV / 卫视 */
  function switchTab(i) {
    var t = tabs();
    if (!t.length || i < 0 || i >= t.length) return false;
    /* 切 tab 本身就是一次换台（站点会重新加载流），所以：
       ① 撤掉上下键攒下的待发车 —— 那个目标已经属于旧 tab，发了会打歪；
       ② 把阀门压到 SWITCH_GAP_MS 之后，让随后的上下键也遵守同一节奏。 */
    cancelSwitch();
    fireClick(t[i]);
    switchGateUntil = Date.now() + SWITCH_GAP_MS;

    var settle = function () {
      if (panelOpen) { onEntry = false; idx = 0; paint(true); armAutoHide(); }
      else { onEntry = false; var p = playingIndex(); idx = p >= 0 ? p : 0; paint(false); }
    };
    [400, 900, 1600, 2600].forEach(function (ms) { setTimeout(settle, ms); });
    return true;
  }

  /* 当前活动 tab 下标（活动 tab 的 img src 含 slip） */
  function currentTab() {
    /* 自定义源页的 tab 是文字，没有 slip 图 —— 交给页面自己回答。
       （探针由 assets/custom.js 装上；央视频页面上它是 undefined，行为不变。） */
    if (typeof window.__yspTV_TAB_PROBE === 'function') {
      try { return window.__yspTV_TAB_PROBE(); } catch (e) { return 0; }
    }
    var t = tabs();
    for (var i = 0; i < t.length; i++) {
      var im = t[i].querySelector('img');
      if (im && /slip/i.test(im.getAttribute('src') || '')) return i;
    }
    return 0;
  }

  /* 任何按键都让面板再续 5 秒 */
  function poke() { if (panelOpen) armAutoHide(); }

  // ------------------------------------------------------------------
  // 触摸层（手机端）
  //
  // 电视靠遥控器；手机没有方向键，不给触摸层的话手机上根本没法换台。
  // 手势刻意和遥控器一一对应，避免两套心智：
  //
  //   面板收起   轻点屏幕   = 确认键   → 弹出左侧选台面板
  //              上滑 / 下滑 = 上/下键  → 换下一台 / 上一台（上滑 = 下一台）
  //   面板展开   点频道行   = 确认键   → 选中该台并收起
  //              点 tab     = 左/右键  → 切 CCTV / 卫视
  //              列表内拖动 = 原生滚动，松手后吸附到整行
  //              点别处     = 收起面板
  //              面板外上/下滑 = 收起并换台（意图很明确，不必先点再滑）
  //
  // ⚠️ 两个坑：
  //   ① 点频道行【不合成 click】。真实触摸本身就会依次派发
  //      touchstart→touchend→mousedown→mouseup→click，再合成一次会触发两遍。
  //   ② 列表拖动必须让原生滚动先跑完（含惯性），否则吸附整行会把惯性吃掉。
  //      所以是「停了 260ms 没再滚」才吸附，而不是 touchend 立刻吸附。
  // ------------------------------------------------------------------

  var TAP_SLOP   = 22;    // 位移小于这个值 = 轻点
  var TAP_MAX_MS = 500;   // 且按下时长小于这个值
  var SWIPE_MIN  = 34;    // 位移大于这个值才算滑动

  var snapTimer = null;
  var touchScrolling = false;

  /* 从触摸目标往上找「列表的直接子元素」，找到就是一行 */
  function closestRow(node) {
    var l = document.querySelector(LIST_SEL);
    if (!l) return null;
    while (node && node.parentNode && node.parentNode !== l) node = node.parentNode;
    return (node && node.parentNode === l) ? node : null;
  }

  function isInside(node, el) {
    while (node) { if (node === el) return true; node = node.parentNode; }
    return false;
  }

  function insidePanel(node) {
    return isInside(node, document.querySelector('.tv-main-con-r'));
  }

  /* 触摸目标命中的是哪个 tab，没命中返回 -1 */
  function tabFromNode(node) {
    var t = tabs();
    for (var i = 0; i < t.length; i++) { if (isInside(node, t[i])) return i; }
    return -1;
  }

  /* 把滚动位置吸附到行高整数倍（原生拖动之后用，防止顶边留半行） */
  function snapScroll() {
    var l = document.querySelector(LIST_SEL);
    var rs = rows();
    if (!l || !rs.length) return;
    var rowH = rs[0].getBoundingClientRect().height;
    if (!rowH) return;
    var lb = l.getBoundingClientRect();
    // base 与 scrollTop 无关（见 scrollToRow 注释）
    var base = l.scrollTop + (rs[0].getBoundingClientRect().top - lb.top);
    var n = Math.round((l.scrollTop - base) / rowH);
    var want = base + n * rowH;
    var maxScroll = Math.max(0, l.scrollHeight - l.clientHeight);
    want = Math.max(0, Math.min(want, maxScroll));
    if (Math.abs(l.scrollTop - want) > 0.5) l.scrollTop = want;
  }

  /* 拖动停了才吸附 —— 直接吸附会打断惯性滚动 */
  function armSnap(delay) {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(function () {
      touchScrolling = false;
      if (!panelOpen) return;
      snapScroll();
      armAutoHide();
    }, delay);
  }

  /* 点中频道行：选中该台 + 收起面板。不合成 click，靠真实触摸自己的 click */
  function tapRow(node) {
    var row = closestRow(node);
    if (!row) return false;
    var i = rows().indexOf(row);
    if (i < 0) return false;
    idx = i;
    paint(true);
    var name = labelAt(i);
    closePanel();
    showToast(name);
    return true;
  }

  function touchKind(s, t) {
    var dx = Math.abs(t.clientX - s.x), dy = Math.abs(t.clientY - s.y);
    if (dx < TAP_SLOP && dy < TAP_SLOP && (Date.now() - s.t) < TAP_MAX_MS) return 'tap';
    if (dy >= SWIPE_MIN && dy > dx * 1.15) return 'vswipe';
    if (dx >= SWIPE_MIN) return 'hswipe';
    return 'other';
  }

  function initTouch() {
    var s = null;

    document.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length !== 1) { s = null; return; }
      var t = e.touches[0];
      var l = document.querySelector(LIST_SEL);
      s = { x: t.clientX, y: t.clientY, t: Date.now(), target: e.target,
            inList: !!(l && isInside(e.target, l)) };
      // 手指一碰就续命，别在操作中途被 5 秒自动隐藏收掉
      if (panelOpen) armAutoHide();
    }, true);

    document.addEventListener('touchmove', function () {
      if (panelOpen) armAutoHide();
    }, true);

    document.addEventListener('touchend', function (e) {
      if (!s) return;
      var st = s; s = null;
      var t = (e.changedTouches && e.changedTouches[0]) || null;
      if (!t) return;
      var kind = touchKind(st, t);

      // ---------- 面板展开 ----------
      if (panelOpen) {
        if (kind === 'tap') {
          if (tapRow(st.target)) return;
          var ce = entryEl();
          if (ce && isInside(st.target, ce)) {          // 点「自定义源」入口
            var went = openCustom();
            closePanel();
            if (!went) showToast(entryIsAdd() ? '打不开源管理' : '自定义源不可用（本页桥接缺失）');
            return;
          }
          var ti = tabFromNode(st.target);
          if (ti >= 0) {
            if (ti !== currentTab()) switchTab(ti);
            else armAutoHide();
            return;
          }
          if (insidePanel(st.target)) { armAutoHide(); return; }  // 点面板空白处
          closePanel();
          return;
        }
        if (st.inList && (kind === 'vswipe' || kind === 'other')) {
          touchScrolling = true;
          armSnap(260);
          setTimeout(function () { touchScrolling = false; }, 2000);  // 没滚动时的兜底
          return;
        }
        if (kind === 'vswipe') { closePanel(); move(t.clientY < st.y ? 1 : -1); return; }
        closePanel();
        return;
      }

      // ---------- 面板收起：轻点弹面板 / 上下滑换台 ----------
      if (kind === 'tap') { openPanel(); return; }
      if (kind === 'vswipe') { move(t.clientY < st.y ? 1 : -1); return; }
    }, true);
  }

  /* 首次进 App 提示一下手势（只提示一次，别每次启动都烦人）。
     只在触摸设备上弹：电视上这套手势完全用不到。 */
  function hintOnce() {
    var touchy = (window.__yspTV_TOUCH === true) ||
                 (window.__yspTV_TOUCH === undefined && (navigator.maxTouchPoints || 0) > 0);
    if (!touchy) return;
    try {
      if (localStorage.getItem('ysp-touch-hint') === '2') return;
      localStorage.setItem('ysp-touch-hint', '2');
    } catch (e) {}
    var HINT = '上/下滑 换台　轻点屏幕 选台';
    // 这是【只弹一次】的提示，时机很关键：站点首屏有自己的「全力加载中…」，
    // 那会儿弹出来基本等于白发。所以等视频真的拿到画面尺寸（videoWidth>0）再弹；
    // 万一一直加载不出来，用超时兜底，别变成永远不弹。
    var t0 = Date.now();
    (function waitPicture() {
      var v = document.querySelector('.tv-main-con-l video');
      if (v && v.videoWidth > 0) { showToast(HINT); return; }
      if (Date.now() - t0 > 15000) { showToast(HINT); return; }
      setTimeout(waitPicture, 400);
    })();
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  var mo = null;
  function observe() {
    var l = document.querySelector(LIST_SEL);
    if (!l) return;
    try {
      if (mo) mo.disconnect();
      mo = new MutationObserver(function () {
        /* 光标在「自定义源」入口上时，频道行本来就不该有焦点 ——
           这里要是照旧去 paint()，就会无限重画（见 clearFocus 的注释）。
           这是**第二道**防线：第一道是 clearFocus 不再无谓地写 class。 */
        if (onEntry) return;
        var rs = rows();
        if (!rs.length) return;
        if (!rs.some(function (r) { return r.classList.contains(FOCUS); })) paint(false);
      });
      mo.observe(l, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });

      // 手指拖动列表时，滚动事件持续刷新吸附倒计时（惯性滚完才吸附）
      if (!l.__yspScrollBound) {
        l.__yspScrollBound = true;
        l.addEventListener('scroll', function () {
          if (touchScrolling) armSnap(260);
        }, { passive: true });
      }
    } catch (e) {}
  }

  var booted = false;
  function boot() {
    var l = document.querySelector(LIST_SEL);
    if (!l) { setTimeout(boot, 700); return; }

    if (!booted) {
      booted = true;
      panelOpen = false;
      var r = root();
      if (r) r.classList.remove('ysp-panel-open');   // 默认收起
      notifyPanel();
      fitRows();                                     // 先把行高凑成整数行
      var p = playingIndex();
      idx = p >= 0 ? p : 0;
      onEntry = false;
      ensureEntry();                                 // 一上来就把入口挂上，不用等开面板
      paint(false);
      observe();
      initTouch();                                   // 手机端手势（电视上永远收不到 touch，无副作用）
      hintOnce();
    } else {
      fitRows();
      paint(false);
    }
  }
  boot();
  [1500, 3000, 5000, 8000].forEach(function (ms) { setTimeout(boot, ms); });

  // 视口尺寸变了（旋转 / 分辨率切换）要重新凑行
  try {
    window.addEventListener('resize', function () {
      fitRows();
      paint(false);
    }, false);
  } catch (e) {}

  window.__yspTV = {
    // 遥控器动作
    move: move,                 // 上/下：收起时换台，展开时移光标
    activate: activate,         // 确认：收起时弹出面板，展开时选中并收起
    switchTab: switchTab,       // 左/右：切 CCTV / 卫视
    togglePanel: togglePanel,   // 菜单键
    poke: poke,

    // 状态查询
    isPanelOpen: isPanelOpen,
    currentTab: currentTab,
    index: function () { return idx; },
    onEntry: function () { return onEntry; },        // 光标是否停在「自定义源」入口上
    hasEntry: function () { return !!entryEl(); },
    count: function () { return rows().length; },
    labels: function () { return rows().map(function (r) { return (r.innerText || '').trim(); }); },
    playing: function () { return playingIndex(); },

    // 工具
    paint: paint,
    fitRows: fitRows,
    scrollToRow: scrollToRow,
    snapScroll: snapScroll,
    touchLayer: function () { return !!window.__yspTV_TOUCH || (navigator.maxTouchPoints || 0) > 0; },
    rowHeight: function () {
      var rs = rows();
      return rs.length ? rs[0].getBoundingClientRect().height : 0;
    },
    toast: showToast,
    openPanel: openPanel,
    closePanel: closePanel,
    openCustom: openCustom,
    entryWanted: entryWanted,
    focusEntry: function () {                        // 测试用：把光标直接放到入口上
      if (!panelOpen) openPanel();
      if (!entryEl()) return false;
      onEntry = true; paint(true); armAutoHide(); return onEntry;
    },

    // 换台节流（测试/调参用）
    setSwitchGap: function (ms) { SWITCH_GAP_MS = ms; },
    setSwitchDebounce: function (ms) { SWITCH_DEBOUNCE_MS = ms; },
    switchDebounce: function () { return SWITCH_DEBOUNCE_MS; },
    switchGap: function () { return SWITCH_GAP_MS; },
    switchPending: function () { return switchWant; },       // 待发车目标，-1 = 无
    switchGateLeft: function () { return Math.max(0, switchGateUntil - Date.now()); },
    playerSettled: playerSettled,     // 站点播放器是否已出画（提前解锁 / 气泡守屏都用它）
    cancelSwitch: cancelSwitch,
    flushSwitch: flushSwitch
  };
})();
