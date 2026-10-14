/* ============================================================
   自定义源页 —— 页面侧逻辑
   （app/src/main/assets 下的正本，没有 tools/ 副本）

   分工：
     · inject.js  负责「面板」这一件事：光标、整行对齐滚动、5 秒自动隐藏、触摸手势。
                  原样复用，一个字没改（只加了一个 __yspTV_TAB_PROBE 探针位，
                  见下面「tab 探针」）。
     · 本文件     负责：把源列表灌进面板 DOM、分组 tab、管理浮层、屏上键盘，
                  以及把遥控器按键按当前所处的「层」分发出去。

   三个层次（mode）：
     panel   面板（默认）—— 上/下 换台或移光标，确认 弹面板/选中，左/右 切分组
     menu    管理浮层（菜单）—— 上/下 选项，确认 执行，返回 关闭
     kb      屏上键盘—— 方向键在键盘上走，确认 打字
     delete  删除模式—— 面板保持展开，每行右侧一个 ✕，确认 = 删掉这条

   与 Android 侧的接口：
     JS → Java   window.yspCustom.<fn>(…)     （见文件末尾 bridge 方法一览）
     Java → JS   window.__yspUI.<fn>(…)       （见 window.__yspUI 定义）
   ============================================================ */
(function () {
  'use strict';
  if (window.__yspUI) return;   // 幂等：重复注入不重来一遍

  var ALL_GROUP = '全部';
  var MARKS = { del: '\u2715', bad: '\u26a0' };   // ✕ / ⚠

  // ------------------------------------------------------------------
  // 状态
  // ------------------------------------------------------------------

  var SRC = [];            // 全量源，顺序与 Java 侧一致（行上只存下标）
  var GROUPS = [];         // [{name:'全部', idx:[…]}, {name:'央视', idx:[…]}, …]
  var gTab = 0;            // 当前分组下标
  var playingUrl = '';
  var bad = {};            // url → 1，本次会话内播放失败过
  var mode = 'panel';
  var mgOpen = false;
  var kbOpen = false;
  var mgIdx = 0;
  var clearArm = false;    // 「清空」的二次确认
  // 「退订」的二次确认。刻意和 clearArm 分开：清空是「删掉我手加的 + 清单里的全部」，
  // 退订是「只删这份清单带来的」—— 两个后果不同，确认不能互相顶掉。
  var unlistArm = false;
  var lanText = '', lanErr = '';
  var remoteUrl = '';      // 记住的远程清单地址（空 = 没记住过，「刷新远程清单」不出现）
  var pokeTimer = null;
  // 同一次触摸里 pointerdown 之后紧跟的那个 click（要被丢掉的那个）
  var pendingClick = null;

  var elList, elTabs, elPanel, elMg, elMgCard, elEmpty;

  // ------------------------------------------------------------------
  // 小工具
  // ------------------------------------------------------------------

  function el(id) { return document.getElementById(id); }

  /**
   * 调 Android 侧的桥。
   *
   * ⚠️ 两个坑，都踩过：
   *   ① JavaBridge 是【按参数个数精确匹配】方法的 —— yspCustom.ready('') 会抛
   *      "Method not found"，而不是把多余实参丢掉。所以这里必须严格按调用方
   *      实际给了几个参数去转发，绝不能统一补齐。
   *      （早先写成「一律传两个参数」，结果 ready/lanStart/clear/back 这些
   *        零参方法全部静默失败，页面看起来正常、就是永远收不到源列表。）
   *   ② 桥没装上（例如直接在桌面浏览器打开本页）不能崩 —— 但【装了却调用失败】
   *      必须报出来，否则又变成上面那种静默失败。所以 catch 里 console.log，
   *      由 Android 侧的 WebChromeClient.onConsoleMessage 落到 logcat。
   */
  function bridge(fn) {
    try {
      var B = window.yspCustom;
      if (!B || typeof B[fn] !== 'function') return undefined;
      var n = arguments.length;
      if (n <= 1) return B[fn]();
      if (n === 2) return B[fn](arguments[1]);
      return B[fn](arguments[1], arguments[2]);
    } catch (e) {
      try { console.log('yspBridge 调用失败 ' + fn + ': ' + e); } catch (e2) {}
    }
    return undefined;
  }

  function toast(text) {
    try { if (window.__yspTV && window.__yspTV.toast) window.__yspTV.toast(text); } catch (e) {}
  }

  /** 兜底显示名：没有名字就截一段地址出来，列表里绝不能出现空白行 */
  function fallbackName(url) {
    var s = String(url || '');
    var q = s.indexOf('?');
    if (q > 0) s = s.substring(0, q);
    var i = s.indexOf('://');
    if (i > 0) s = s.substring(i + 3);
    if (s.length > 46) s = s.substring(0, 22) + '\u2026' + s.substring(s.length - 20);
    return s || '(未命名)';
  }

  function div(cls, text) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    if (text !== undefined && text !== null) d.textContent = text;   // ⚠️ 一律 textContent
    return d;
  }

  function span(cls, text) {
    var s = document.createElement('span');
    if (cls) s.className = cls;
    if (text !== undefined && text !== null) s.textContent = text;
    return s;
  }

  function findSrc(url) {
    for (var i = 0; i < SRC.length; i++) if (SRC[i].u === url) return SRC[i];
    return null;
  }

  // ------------------------------------------------------------------
  // 源列表 → 面板
  // ------------------------------------------------------------------

  function rebuildGroups() {
    GROUPS = [{ name: ALL_GROUP, idx: [] }];
    var byName = {}, order = [], i, g;
    for (i = 0; i < SRC.length; i++) {
      GROUPS[0].idx.push(i);
      g = String(SRC[i].g || '').trim() || '自建';
      if (!byName[g]) { byName[g] = { name: g, idx: [] }; order.push(g); }
      byName[g].idx.push(i);
    }
    for (i = 0; i < order.length; i++) GROUPS.push(byName[order[i]]);
    if (gTab >= GROUPS.length) gTab = 0;
  }

  function renderTabs() {
    if (!elTabs) return;
    while (elTabs.firstChild) elTabs.removeChild(elTabs.firstChild);
    var frag = document.createDocumentFragment();
    for (var i = 0; i < GROUPS.length; i++) {
      var t = div('tv-main-con-r-tab-img' + (i === gTab ? ' on' : ''), GROUPS[i].name);
      t.setAttribute('data-g', String(i));
      frag.appendChild(t);
    }
    elTabs.appendChild(frag);
    scrollTabIntoView();
  }

  /**
   * 把当前分组滚进 tab 条幅的可见区。
   *
   * ⚠️ 少了这一步，分组一多就变成「tab 栏看着像冻住了」：
   *   条幅 clientWidth 只有面板宽（1080p 电视上 192px），而 10 个分组要 ~900px，
   *   overflow-x:auto 会把排在后面的直接裁掉；光标切到第 3 组之后，
   *   选中项已经在可视区之外 —— 列表内容变了，用户却完全看不出自己在第几组。
   *   （真事：拿 best-fan/iptv-sources 的 cn_all.m3u8 实测，11 个 tab / 899px，
   *     scrollLeft 一路恒为 0，只有前 2 个 tab 能看见。）
   *
   * 刻意【不用】scrollIntoView：它会把所有可滚动祖先一起滚（含页面本身），
   * 在 TV 上表现为整块画面乱跳。这里只动这一个条幅的 scrollLeft。
   */
  function scrollTabIntoView() {
    if (!elTabs) return;
    var on = elTabs.querySelector('.on');
    if (!on) return;
    var max = elTabs.scrollWidth - elTabs.clientWidth;
    if (max <= 0) return;                 // 排得下就别动它
    var tr = elTabs.getBoundingClientRect();
    var or = on.getBoundingClientRect();
    // 把选中项对到条幅中间（首尾自动夹紧，不会滚过头）
    var delta = (or.left + or.width / 2) - (tr.left + tr.width / 2);
    elTabs.scrollLeft = Math.max(0, Math.min(elTabs.scrollLeft + delta, max));
  }

  function renderList() {
    if (!elList) return;
    var idx = (GROUPS[gTab] || { idx: [] }).idx;
    var frag = document.createDocumentFragment();

    for (var k = 0; k < idx.length; k++) {
      var i = idx[k], s = SRC[i];
      if (!s) continue;
      var row = document.createElement('div');
      var cls = 'ysp-row';
      if (playingUrl && s.u === playingUrl) cls += ' tvSelect';
      if (bad[s.u]) cls += ' bad';
      row.className = cls;
      row.setAttribute('data-i', String(i));
      if (mode === 'delete') row.setAttribute('data-mark', MARKS.del);
      else if (bad[s.u]) row.setAttribute('data-mark', MARKS.bad);
      // 里层再套一层 .ysp-t 承接省略号（理由见 custom.css §3）
      var sp = span(null, null);
      sp.appendChild(span('ysp-t', s.n || fallbackName(s.u)));
      row.appendChild(sp);
      frag.appendChild(row);
    }

    while (elList.firstChild) elList.removeChild(elList.firstChild);
    elList.appendChild(frag);

    if (elPanel) {
      if (idx.length) elPanel.classList.remove('ysp-no-src');
      else elPanel.classList.add('ysp-no-src');
    }
    if (elEmpty) {
      elEmpty.textContent = SRC.length
        ? '这个分组下没有源。'
        : '还没有任何自定义源。\n\n按【确认键】（或「菜单」键）打开源管理：\n  · 局域网导入：手机/电脑打开屏幕上显示的网址，粘贴清单或直接填清单网址\n  · 从剪贴板导入：手机上复制好的网址或清单，按一下就进来\n  · 屏上输入新源：用遥控器打字添加一条';
    }
  }

  /** 把 .tvSelect 打到正在播放的那一行（inject.js 的 playingIndex() 靠它定位） */
  function markSelect() {
    if (!elList) return;
    var rows = elList.children, i, r, s;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (!r.getAttribute || r.getAttribute('data-i') === null) continue;
      s = SRC[+r.getAttribute('data-i')];
      if (s && playingUrl && s.u === playingUrl) r.classList.add('tvSelect');
      else r.classList.remove('tvSelect');
    }
  }

  /**
   * 重排之后把光标放回「合理的位置」。
   *
   * 面板展开时 inject.js 只按当前 idx 画光标，不会自动归零 ——
   * 分组切换后 idx 可能指到别的源上。move(-9999) 会被 clamp 到 0。
   * 而 move(0) 原地不动（只重画 + 续自动隐藏）—— 删除模式下正需要这个：
   * 删掉一条之后光标应该停在原处，而不是跳回顶部。
   *
   * ⚠️ 只有面板展开时 move() 才「只移光标不换台」。面板收起时 move() 会真的
   *    换台（activateAt），所以这里必须先判 panelOpen。
   */
  function resetCursor(toTop) {
    var T = window.__yspTV;
    if (!T) return;
    try {
      if (T.isPanelOpen()) T.move(toTop ? -9999 : 0);
      else T.paint(false);
      if (T.fitRows) T.fitRows();
    } catch (e) {}
  }

  function setGroup(i) {
    if (!GROUPS.length) return;
    if (i < 0) i = 0;
    if (i >= GROUPS.length) i = GROUPS.length - 1;
    gTab = i;
    renderTabs();
    renderList();
    resetCursor(true);
    var T = window.__yspTV;
    if (T && T.isPanelOpen) { try { T.fitRows(); T.paint(true); } catch (e) {} }
  }
  // ------------------------------------------------------------------
  // tab 探针
  //
  // inject.js 的 currentTab() 是给央视频写的：它读 tab 里 <img> 的 src 里有没有
  // "slip" 来判断哪个 tab 是活动的。本页的 tab 是文字，没有图，那个判断永远返回 0。
  // inject.js 里留了一个探针位，有 __yspTV_TAB_PROBE 就交给页面回答。
  // ------------------------------------------------------------------
  window.__yspTV_TAB_PROBE = function () { return gTab; };

  // ------------------------------------------------------------------
  // 行的点击 → 选台 / 删除
  //
  // inject.js 的 activate() / move()（面板收起时）最终都是 fireClick(行)，
  // 所以这里一个委托监听就能同时覆盖「面板里按确认」和「收起时上下键换台」两条路。
  // ------------------------------------------------------------------

  function rowFrom(node) {
    var row = node;
    while (row && row !== elList) {
      if (row.className && String(row.className).indexOf('ysp-row') >= 0
          && row.getAttribute && row.getAttribute('data-i') !== null) return row;
      row = row.parentNode;
    }
    return null;
  }

  function onListClick(e) {
    var row = rowFrom(e.target);
    if (!row) return;
    var s = SRC[+row.getAttribute('data-i')];
    if (!s) return;
    if (mode === 'delete') {
      bridge('del', s.u);
      return;
    }
    bridge('pick', s.u);
  }

  function onTabsClick(e) {
    var t = e.target;
    while (t && t !== elTabs) {
      if (t.getAttribute && t.getAttribute('data-g') !== null) {
        setGroup(+t.getAttribute('data-g'));
        return;
      }
      t = t.parentNode;
    }
  }

  // ------------------------------------------------------------------
  // 管理浮层：菜单
  // ------------------------------------------------------------------

  function menuItems() {
    var n = SRC.length;
    var items = [
      { id: 'lan', label: '局域网导入',
        tail: lanText ? '已开启' : (lanErr || '正在开启\u2026') },
      { id: 'clip', label: '从剪贴板导入', tail: '网址或清单内容' },
      { id: 'input', label: '屏上输入新源', tail: '直播流 / 清单网址' }
    ];
    // 只有记住过清单地址才出现。没有这一项时，用户按下去只会得到一句
    // 「还没记住任何清单地址」，不如一开始就别摆出来。
    // ⚠️ 位置必须排在「屏上输入新源」【之后】：测试和很多操作习惯都按下标定位菜单，
    //    把新项插在前面会让所有下标位移。
    if (remoteUrl) {
      items.push({ id: 'refresh', label: '同步这份清单',
        tail: n ? '按上游现状更新（上游删了的会一起删）' : '重抓这份清单' });
      // v1.11：退订。放在「同步」紧后面 —— 两个动作是同一件事的两头
      //（同步=让它对上、退订=不要了），挨在一起用户不用在菜单里找。
      items.push({ id: 'unlist',
        label: unlistArm ? '再按一次确认退订' : '退订这份清单',
        tail: unlistArm ? '会删掉它带来的全部源，且地址也清掉'
                        : '删掉它带来的全部源',
        danger: true });
    }
    items.push(
      { id: 'play', label: '选台播放', tail: n ? '共 ' + n + ' 条 \u00b7 展开源列表' : '（还没有源）',
        dim: !n },
      { id: 'del', label: '删除源', tail: n ? '进入删除模式' : '（还没有源）', dim: !n },
      { id: 'clear', label: clearArm ? '再按一次确认清空' : '清空全部源',
        tail: n ? '共 ' + n + ' 条' : '（已经是空的）', danger: true, dim: !n },
      { id: 'close', label: '关闭', tail: '返回播放' }
    );
    return items;
  }

  function buildMenu() {
    while (elMgCard.firstChild) elMgCard.removeChild(elMgCard.firstChild);

    // ---- 头 ----
    var head = div('mg-head');
    head.appendChild(div('mg-title', '源管理'));
    var cur = findSrc(playingUrl);
    head.appendChild(div('mg-sub',
      '共 ' + SRC.length + ' 条源' + (cur ? ' \u00b7 正在播放：' + (cur.n || fallbackName(cur.u)) : '')));
    if (lanText) {
      var lan = div('mg-lan');
      // 提示语刻意压到一行：卡片高度封顶 84vh，头部每多一行，下面能看见的
      // 菜单项就少一行（这一块现在有两组地址要显示）
      lan.appendChild(div('mg-lan-tip', '手机/电脑浏览器打开（可粘贴清单，也可填清单网址）'));
      lan.appendChild(div('mg-lan-url', lanText));
      head.appendChild(lan);
    } else if (lanErr) {
      head.appendChild(div('mg-lan-tip bad', '局域网服务没能开启：' + lanErr));
    }
    // 记住的远程清单：显示出来，用户才知道「刷新远程清单」刷的是哪一份
    if (remoteUrl) {
      var rm = div('mg-lan');
      rm.appendChild(div('mg-lan-tip', '已记住的清单（下面可刷新）'));
      rm.appendChild(div('mg-lan-url', remoteUrl));
      head.appendChild(rm);
    }
    elMgCard.appendChild(head);

    // ---- 菜单 ----
    var items = menuItems();
    if (mgIdx >= items.length) mgIdx = 0;
    var listEl = div('mg-list');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var r = div('mg-item' + (i === mgIdx ? ' on' : '')
        + (it.danger ? ' danger' : '') + (it.dim ? ' dim' : ''));
      // 手机上靠 data-i 反查是哪一项（点击委托，见 onMenuClick）
      r.setAttribute('data-i', String(i));
      r.appendChild(div('mg-label', it.label));
      r.appendChild(div('mg-tail', it.tail));
      listEl.appendChild(r);
    }
    elMgCard.appendChild(listEl);

    // 「下面还有 N 项」的提示条：夹在列表和按键提示之间，只在放不下时出现
    var more = div('mg-more');
    elMgCard.appendChild(more);
    listEl.addEventListener('scroll', updateMenuMore);

    elMgCard.appendChild(div('mg-foot',
      '上/下 选择 \u00b7 确认 执行 \u00b7 返回 关闭        （长按菜单键也可开关本页）'));

    scrollMenuIntoView();
  }

  /**
   * 更新「▲ 上面还有 N 项 / ▼ 下面还有 N 项」这条提示。
   *
   * ⚠️ 为什么需要：`.mg-list` 关掉了滚动条（电视上不该出现滚动条），
   *    而下面那个 scrollMenuIntoView() 只保证「当前选中项可见」——
   *    光标停在第一项时，后面几项确实被裁在卡片外，界面上却没有任何迹象
   *    说明「下面还有」，看上去就像菜单少了半截（v1.3 的截图就是这样：
   *    8 项只看得见 4 项，另外 4 项不是没有，是没有任何提示）。
   *    修「光标可见」和修「知道下面还有东西」是两件事，两件都要做。
   */
  function updateMenuMore() {
    if (!elMgCard) return;
    var list = elMgCard.querySelector('.mg-list');
    var box = elMgCard.querySelector('.mg-more');
    if (!list || !box) return;
    var rows = list.querySelectorAll('.mg-item');
    // ⚠️ 一律用 getBoundingClientRect（视口坐标）来判：`.mg-list` 没有 position，
    //    offsetTop 会挂到更外层去，算出来的数看着对、其实全错。
    var lr = list.getBoundingClientRect();
    var above = 0, below = 0;
    for (var i = 0; i < rows.length; i++) {
      var rr = rows[i].getBoundingClientRect();
      if (rr.bottom <= lr.top + 1) above++;
      else if (rr.top >= lr.bottom - 1) below++;
    }
    var parts = [];
    if (above) parts.push('\u25b2 上面还有 ' + above + ' 项');
    if (below) parts.push('\u25bc 下面还有 ' + below + ' 项');
    // 边缘淡出：把被裁掉的那半行抹掉，别让它一截一截地露在卡片口上。
    // 用 class 切换而不是改 padding —— 改 padding 会动到布局，
    // 又会绕回「提示条出现 → 列表变矮 → 光标行被顶出去」那个回路里去。
    list.className = 'mg-list'
      + (above && below ? ' cut-both' : above ? ' cut-top' : below ? ' cut-bot' : '');
    if (!parts.length) { box.className = 'mg-more'; box.textContent = ''; return; }
    box.className = 'mg-more on';
    box.textContent = parts.join('        ');
  }

  /**
   * 把当前选中的菜单项滚进列表的可见区。
   *
   * ⚠️ 为什么非有不可：卡片高度封顶 84vh（`.mg-card` 的 max-height），
   *    菜单项多了之后 `.mg-list` 只剩 ~190px，而 8 项要 ~360px。
   *    `.mg-list` 虽然是 `overflow-y:auto`，但**没人去滚它** ——
   *    于是光标走过第 4 项之后，高亮那行就落在卡片外面：按键照样有反应
   *    （状态在变），用户却看不见自己在哪一项，只能凭感觉数。
   *    （真事：v1.3 加了「刷新远程清单」之后，截图上只剩前 4 项可见，
   *      后面 删除源 / 恢复示例 / 清空 / 关闭 全被裁掉。加之前就已经临界了，
   *      只是裁剪量小到容易被忽略。）
   *
   * 只做「最小滚动」：越界多少滚多少，不把选中项对到正中 ——
   * 菜单上下键来回按时，整块内容跳来跳去比看不见更难受。
   * （和 tab 条幅那个 scrollTabIntoView 是同一类问题、同一种修法，区别只在
   *   那边要对到中间，因为 tab 是横向的、一次看一排。）
   */
  function scrollMenuIntoView() {
    if (!elMgCard) return;
    var list = elMgCard.querySelector('.mg-list');
    if (!list) return;
    var on = list.querySelector('.mg-item.on');
    if (!on) return;
    /* ⚠️ 为什么必须走两遍：
       「下面还有 N 项」那条提示（updateMenuMore）自己会占掉一行高度，
       而它出不出又取决于列表放不放得下 —— 于是形成回路：
         滚的时候还没有提示条 → 滚完提示条冒出来 → 列表矮了一行
         → 刚对准到下边缘的那一行又被顶了出去（按键有反应、行却看不见）。
       实测症状：光标走到第 4 项之后，第 4~7 项全部跑到卡片外，
       而且「提示条说的条数」和「实际被裁的条数」差 1。
       修法：第一遍滚 → 决定提示条出不出来 → 第二遍按最终高度再滚一次。
       提示条的显隐只会因为「放不放得下」翻转，第二遍之后必然稳定，不会来回抖。 */
    for (var pass = 0; pass < 2; pass++) {
      var max = list.scrollHeight - list.clientHeight;
      if (max > 0) {                         // 放得下就别动它
        var lr = list.getBoundingClientRect();
        var or = on.getBoundingClientRect();
        if (or.bottom > lr.bottom) list.scrollTop += (or.bottom - lr.bottom);
        else if (or.top < lr.top) list.scrollTop -= (lr.top - or.top);
        list.scrollTop = Math.max(0, Math.min(list.scrollTop, max));
      }
      updateMenuMore();                      // 滚没滚都要算：放得下时这条提示得收掉
    }
  }

  /**
 * 浮层点击的总分发（手机上唯一的操作方式）。
 *
 * ⚠️ 为什么以前手机上「点了没反应」：浮层里的一切（菜单项、键盘键、栏位）
 *    都是**纯键盘驱动**的 —— 从来没绑过任何点击事件，全靠 CustomActivity
 *    把遥控器 DPAD/OK 翻译成 key('UP'/'DOWN'/'OK')。手机上没有遥控器，
 *    于是「从剪贴板导入」「屏上输入新源」这些只能靠手点的项**一个都点不动**
 *    （实测：touch 事件确实命中了 .mg-item，但 idx 不动、toast 不变）。
 *    这个洞在电视上永远看不见 —— 遥控器把一切都代劳了。
   *
   * 语义定成「点哪一项 = 跳到那一项 + 立刻执行」，而不是「先选中再按确认」：
   *   手指已经落在某一项上了，再要求用户按一次没有物理位置的确认键，
   *   在触屏上是没有对应动作的。
   *
   * 绑在 #ysp-manage（事件委托）而不是每一行：菜单和键盘每次 buildXxx 都整块
   * 重建，绑在重建出来的容器上会在重建后失效。
   */
  function onManagePointer(e) {
    if (!elMg || !elMg.classList.contains('on')) return;
    // pointerdown 立刻响应（触屏上click 有延迟、还容易被滚动/长按吃掉），
    // 紧接着的 click 必须丢掉 —— 同一次触摸只算一次，
    // 否则「清空全部源」这种两段式动作会在一次点击里直接执行掉，
    // 中间的「再按一次确认」等于没有。
    //
    // ⚠️ 只能按「同一位置 + 同一个手势配对」来丢，不能按「同一项 700ms 内」丢：
    //    那样用户在键盘上连点同一个字母（要打一串地址，这是最常见的操作）
    //    会被吃掉第二次，整个键盘基本不可用。这个坑踩过。
    var byPointer = !!(e && e.type === 'pointerdown');
    if (byPointer) pendingClick = { t: Date.now() };
    else if (pendingClick && Date.now() - pendingClick.t < 700) {
      pendingClick = null;
      return;                        // 这是刚才那次 pointerdown 的回声
    } else pendingClick = null;
    if (kbOpen) onKbClick(e);
    else onMenuClick(e);
  }

  function onMenuClick(e) {
    var t = e && e.target;
    // 点到的是行内的 .mg-label / .mg-tail，向上找带 data-i 的那一行
    var row = t && t.closest ? t.closest('.mg-item') : null;
    if (!row) return;
    var i = +row.getAttribute('data-i');
    var items = menuItems();
    if (!(i >= 0) || i >= items.length) return;

    mgIdx = i;
    // ⚠️ 这里【不能】无脑clearArm = false。
    //    「清空全部源」是两段式：第一次点把菜单改名成「再按一次确认清空」并武装，
    //    第二次点才真清。而清空那一项的 i 两次都一样 —— 一旦在这里把 clearArm
    //    清掉，第二次点击又从第一段重来，用户点多少下都清不掉（实测菜单项一直
    //    显示「清空全部源」、源还在）。
    //    正确做法跟 mgKey 里的 UP/DOWN 一致：只有【光标移到别的项】才解除武装
    //    （mgKey 的 UP/DOWN 分支里有 clearArm = false），点同一项则保留。
    buildMenu();
    // dim 项（还没有源时的选台/删除/清空）点了只解释一句，不执行 ——
    // 键盘路径上它们也能选中后按 OK，这里保持同一套语义。
    if (it0Dim(i)) { clearArm = false; buildMenu(); toast('这一项现在用不了：' + (items[i].tail || '')); return; }
    runMenu();
  }

  /** 点键盘上的某个键：光标移到那儿并立刻按下去（等价于「移动 + 确认」） */
  function onKbClick(e) {
    var t = e && e.target;
    // ⚠️ 这个局部变量【不能】叫 key：文件里有个同名的 function key(name)（按键分发），
    //    var key = ... 在整个函数作用域里把它遮蔽掉，于是下面那句 key('OK')
    //    实际是在拿 DOM 元素当函数调 → TypeError，字符永远打不出来。
    //    这个坑的表现特别坑：菜单项点击照常工作（onMenuClick 里没有同名局部变量），
    //    只有键盘完全失灵，而抛的错被 WebView 吞掉、连日志都看不到。
    var keyEl = t && t.closest ? t.closest('.kb-key') : null;
    if (!keyEl) return;
    var r = +keyEl.getAttribute('data-r'), c = +keyEl.getAttribute('data-c');
    if (!(r >= 0) || !(c >= 0)) return;
    kb.r = r; kb.c = c;
    key('OK');
  }

  /** dim 项（还没有源时的选台/删除/清空）点了只给一句解释，不执行 */
  function it0Dim(i) {
    var it = menuItems()[i];
    return !!(it && it.dim);
  }

  function runMenu() {
    var items = menuItems();
    var it = items[mgIdx];
    if (!it) return;
    // 「清空」是两段式：武装状态只对【清空自己】有效。
    // 点/按键换到任何别的项都该解除 —— 键盘路径原来靠 mgKey 的 UP/DOWN 里那句
    // clearArm = false，但鼠标点击没有 UP/DOWN，不在这里统一处理的话
    // 「武装中」会一直挂着：用户点了别的项，再回来点一下清空就直接清掉了。
    if (it.id !== 'clear') clearArm = false;
    if (it.id !== 'unlist') unlistArm = false;
    switch (it.id) {
      case 'lan':
        // 再点一次重新探一次地址（网卡换了 / 服务没起来）
        lanErr = ''; lanText = '';
        buildMenu();
        bridge('lanStart');
        break;
      case 'input':
        openKb();
        break;
      case 'refresh':
        // 抓取在 Android 侧的后台线程上做，回来时只弹一句结果（见 __yspUI.addResult 之外
        // 的 toast 那条路：刷新没有键盘可停留，所以用 toast）
        toast('正在抓取清单\u2026');
        bridge('refresh');
        break;
      case 'play':
        if (!SRC.length) { toast('还没有源'); return; }
        closeManage();
        setTimeout(function () {
          try { if (window.__yspTV) window.__yspTV.openPanel(); } catch (e) {}
        }, 260);
        break;
      case 'del':
        if (!SRC.length) { toast('还没有源'); return; }
        enterDelete();
        break;
      case 'clip':
        // 剪贴板是电视上唯一的「粘」法（屏上键盘一个字符一个字符敲）。
        // 真正的读取在 Android 侧（getPrimaryClip 必须回主线程），结果由
        // __yspUI.clipResult 回调进来 —— 这里只管发请求 + 给个「在读」的提示。
        toast('正在读取剪贴板…');
        bridge('clip');
        break;
      case 'clear':
        if (!SRC.length) { toast('已经是空的'); return; }
        if (!clearArm) { clearArm = true; buildMenu(); return; }
        clearArm = false;
        bridge('clear');
        break;
      case 'unlist':
        // 二次确认：第一次只改名，第二次才真退订（和「清空」同一套手势）
        if (!unlistArm) { unlistArm = true; buildMenu(); return; }
        unlistArm = false;
        toast('正在退订…');
        bridge('unlist');
        break;
      case 'close':
        closeManage();
        break;
    }
  }

  function mgKey(name) {
    var items = menuItems();
    if (name === 'UP') { mgIdx = (mgIdx <= 0) ? items.length - 1 : mgIdx - 1; clearArm = false; buildMenu(); }
    else if (name === 'DOWN') { mgIdx = (mgIdx >= items.length - 1) ? 0 : mgIdx + 1; clearArm = false; buildMenu(); }
    else if (name === 'OK') runMenu();
    else if (name === 'BACK') closeManage();
  }

  // ------------------------------------------------------------------
  // 管理浮层：屏上键盘
  // ------------------------------------------------------------------

  var KB_LOWER = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '_', '.', '~'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', ':', '/'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '?', '=', '@'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '#', '%', '&', '+', ',']
  ];
  var KB_FN = ['\u7a7a\u683c', '\u5220\u9664', '\u6e05\u7a7a', '\u5c0f\u5199',
               '\u540d\u79f0/\u5730\u5740', '\u4fdd\u5b58', '\u53d6\u6d88'];
  // 功能键下标，写死在这里比在 kbPress 里数位置安全
  var FN = { SPACE: 0, DEL: 1, CLR: 2, CASE: 3, SWAP: 4, SAVE: 5, CANCEL: 6 };

  var kb = { field: 1, r: 3, c: 0, shift: false, name: '', url: '', msg: '' };

  function kbRows() {
    var rows = [];
    for (var i = 0; i < KB_LOWER.length; i++) {
      var src = KB_LOWER[i], out = [];
      for (var j = 0; j < src.length; j++) out.push(kb.shift ? src[j].toUpperCase() : src[j]);
      rows.push(out);
    }
    var fn = KB_FN.slice();
    fn[FN.CASE] = kb.shift ? '\u5927\u5199' : '\u5c0f\u5199';
    rows.push(fn);
    return rows;
  }

  function openKb(name, url) {
    kb.field = url || !name ? 1 : 0;
    kb.r = 3; kb.c = 0;
    kb.name = name || '';
    kb.url = url || '';
    kb.msg = '';
    kbOpen = true;
    mode = 'kb';
    buildKb();
    elMg && elMg.classList.add('on');
    document.body.classList.add('ysp-managing');
  }

  function closeKb() {
    kbOpen = false;
    mode = 'menu';
    buildMenu();
  }

  function buildKb() {
    while (elMgCard.firstChild) elMgCard.removeChild(elMgCard.firstChild);

    var head = div('mg-head');
    head.appendChild(div('mg-title', '添加一条源'));

    var f0 = div('kb-field' + (kb.field === 0 ? ' active' : ''));
    f0.appendChild(div('kb-label', '名称（可留空，自动用地址兜底）'));
    var v0 = div('kb-value');
    v0.textContent = kb.name;
    if (kb.field === 0) v0.appendChild(div('caret'));
    f0.appendChild(v0);
    head.appendChild(f0);

    var f1 = div('kb-field' + (kb.field === 1 ? ' active' : ''));
    f1.appendChild(div('kb-label', '地址（一路直播流，或一份 m3u 清单的网址）'));
    var v1 = div('kb-value');
    v1.textContent = kb.url;
    if (kb.field === 1) v1.appendChild(div('caret'));
    f1.appendChild(v1);
    head.appendChild(f1);

    elMgCard.appendChild(head);

    var box = div('kb-rows');
    var rows = kbRows();
    for (var r = 0; r < rows.length; r++) {
      var rowEl = div('kb-row');
      for (var c = 0; c < rows[r].length; c++) {
        var cls = 'kb-key';
        if (r === rows.length - 1) cls += ' fn';
        if (r === rows.length - 1 && c === FN.SWAP) cls += ' wide';
        if (r === kb.r && c === kb.c) cls += ' on';
        var keyEl = div(cls, rows[r][c]);
        // 手机上靠 data-r/data-c 反查按了哪个键（点击委托，见 onKbClick）
        keyEl.setAttribute('data-r', String(r));
        keyEl.setAttribute('data-c', String(c));
        rowEl.appendChild(keyEl);
      }
      box.appendChild(rowEl);
    }
    elMgCard.appendChild(box);

    var foot = div('mg-foot');
    foot.textContent = kb.msg
      ? kb.msg
      : '方向键 选键 \u00b7 确认 按下 \u00b7 左/右 切换「名称 / 地址」栏位\u3000返回 返回菜单';
    elMgCard.appendChild(foot);
  }

  function kbFieldLen() {
    return kb.field === 0 ? kb.name.length : kb.url.length;
  }

  function kbAppend(ch) {
    if (kb.field === 0) kb.name += ch;
    else kb.url += ch;
  }

  function kbBackspace() {
    if (kb.field === 0) kb.name = kb.name.slice(0, -1);
    else kb.url = kb.url.slice(0, -1);
  }

  function kbClearField() {
    if (kb.field === 0) kb.name = '';
    else kb.url = '';
  }

  function kbSave() {
    var url = kb.url.trim();
    var name = kb.name.trim();
    if (!url) { kb.msg = '地址不能为空'; buildKb(); return; }
    if (!/^[a-z][a-z0-9+.\-]*:\/\//i.test(url)) {
      kb.msg = '地址要以 http:// 或 https:// 这类协议开头';
      buildKb();
      return;
    }
    // ⚠️ 文案从「正在添加」改成「正在获取」：这一版起，Android 侧会先把这个地址
    //    抓一遍（判断它是一路直播流还是一份频道清单），最坏要几秒。
    //    写着「正在添加」却卡几秒，会让人以为卡死了。
    kb.msg = '正在获取\u2026';
    buildKb();
    bridge('add', name, url);      // 结果由 __yspUI.addResult(ok, msg) 回来
  }

  function kbPress() {
    var rows = kbRows();
    var isFn = (kb.r === rows.length - 1);
    var label = rows[kb.r][kb.c];

    if (!isFn) { kbAppend(label); kb.msg = ''; buildKb(); return; }

    switch (kb.c) {
      case FN.SPACE:  kbAppend(' '); kb.msg = ''; break;
      case FN.DEL:    kbBackspace(); kb.msg = ''; break;
      case FN.CLR:    kbClearField(); kb.msg = ''; break;
      case FN.CASE:   kb.shift = !kb.shift; kb.msg = ''; break;
      case FN.SWAP:   kb.field = kb.field === 0 ? 1 : 0; kb.msg = ''; break;
      case FN.SAVE:   kbSave(); return;
      default:        closeKb(); return;
    }
    buildKb();
  }

  function kbKey(name) {
    var rows = kbRows();

    if (name === 'LEFT' || name === 'RIGHT') {
      var last = rows[kb.r].length - 1;
      if (name === 'LEFT' && kb.c === 0) {
        kb.field = kb.field === 0 ? 1 : 0;          // 顶到行首再左 = 换栏位
      } else if (name === 'RIGHT' && kb.c >= last) {
        kb.field = kb.field === 0 ? 1 : 0;          // 顶到行尾再右 = 换栏位
      } else {
        kb.c = Math.max(0, Math.min(kb.c + (name === 'LEFT' ? -1 : 1), last));
      }
      buildKb();
      return;
    }

    if (name === 'UP' || name === 'DOWN') {
      var nr = kb.r + (name === 'UP' ? -1 : 1);
      if (nr < 0 || nr >= rows.length) return;
      // 从功能键行的「名称/地址」往上，落回字母区最右一列，别跳到别的键上
      if (name === 'UP' && kb.r === rows.length - 1 && kb.c === FN.SWAP) nr = 3;
      kb.r = nr;
      kb.c = Math.min(kb.c, rows[kb.r].length - 1);
      buildKb();
      return;
    }

    if (name === 'OK') { kbPress(); return; }
    if (name === 'BACK') { closeKb(); return; }
  }

  // ------------------------------------------------------------------
  // 管理浮层：开 / 关 / 删除模式
  // ------------------------------------------------------------------

  function openManage() {
    if (mgOpen && mode === 'menu') return;
    stopPoke();
    mgOpen = true;
    kbOpen = false;
    mode = 'menu';
    mgIdx = 0;
    clearArm = false; unlistArm = false;
    clearArm = false;
    lanText = ''; lanErr = '';
    buildMenu();
    if (elMg) elMg.classList.add('on');
    document.body.classList.add('ysp-managing');

    // 面板收起来（它和浮层抢屏幕空间，而且 move() 在面板收起时会真的换台）
    try { if (window.__yspTV) window.__yspTV.closePanel(); } catch (e) {}
    bridge('manage', true);   // 让 Android 知道浮层开着，菜单键才好判「开还是关」
    bridge('lanStart');       // 幂等：已经在跑就只把地址再推一次
  }

  function closeManage() {
    if (!mgOpen) return;
    mgOpen = false;
    kbOpen = false;
    mode = 'panel';
    clearArm = false;
    stopPoke();
    if (elMg) elMg.classList.remove('on');
    document.body.classList.remove('ysp-managing');
    bridge('manage', false);
    bridge('lanStop');
    // 面板在 display:none 期间 rows() 恒为空，重新显示后要把行高/光标补一遍
    setTimeout(function () {
      try {
        if (window.__yspTV) { window.__yspTV.fitRows(); window.__yspTV.paint(false); }
      } catch (e) {}
    }, 60);
  }

  /**
   * 删除模式：面板保持展开，每行右侧打 ✕，确认 = 删除该条。
   *
   * ⚠️ inject.js 的面板有「5 秒无操作自动隐藏」。一旦它把面板收起来，
   *    下一次上/下键就会变成「换台」而不是「移光标」，而这里又会把点击解释成
   *    「删除」—— 手一抖就把源删了。所以删除模式期间用定时 poke() 顶住自动隐藏。
   */
  function enterDelete() {
    if (!SRC.length) return;
    mode = 'delete';
    mgOpen = false;          // 浮层收起来，把屏幕让给面板列表
    stopPoke();
    pokeTimer = setInterval(function () {
      try { if (mode === 'delete' && window.__yspTV) window.__yspTV.poke(); } catch (e) {}
    }, 2500);

    if (elMg) elMg.classList.remove('on');
    document.body.classList.remove('ysp-managing');
    bridge('manage', false);
    renderList();
    setTimeout(function () {
      try {
        var T = window.__yspTV;
        if (!T) return;
        if (!T.isPanelOpen()) T.openPanel();
        T.fitRows(); T.paint(true);
      } catch (e) {}
      toast('删除模式：选到哪条按确认就删哪条，返回键回菜单');
    }, 80);
  }

  function exitDelete() {
    stopPoke();
    renderList();
    try { if (window.__yspTV) { window.__yspTV.fitRows(); window.__yspTV.paint(false); } } catch (e) {}
  }

  function stopPoke() {
    if (pokeTimer) { clearInterval(pokeTimer); pokeTimer = null; }
  }

  // ------------------------------------------------------------------
  // 按键分发
  // ------------------------------------------------------------------

  /**
   * 面板收起时要先把它展开。
   *
   * 为什么：整个「选台列表 + 分组 tab」就是这块面板，收起时左移出屏。
   * 此时按左/右键会静默换分组 —— 列表和 tab 都在屏外，用户什么都看不到，
   * 只觉得按键坏了。（右/左键是分组切换，上/下键才是换台，很多人会混着按。）
   *
   * 面板宽高不随展开动画变（收起是 transform 位移，不是改 width），
   * 所以紧接着 fitRows/paint 取值是准的，不存在「动画没完就量」的问题。
   */
  function ensurePanel() {
    try {
      var T = window.__yspTV;
      if (T && T.isPanelOpen && !T.isPanelOpen()) T.openPanel();
    } catch (e) {}
  }

  function panelKey(name) {
    var T = window.__yspTV;
    if (!T) return;

    if (mode === 'delete') {
      // 自动隐藏万一还是把面板收掉了，先补开，保证上/下只移光标不换台
      try { if (!T.isPanelOpen()) T.openPanel(); } catch (e) {}
    }

    switch (name) {
      case 'UP': T.move(-1); return;
      case 'DOWN': T.move(1); return;
      case 'LEFT': ensurePanel(); setGroup(gTab - 1); return;
      case 'RIGHT': ensurePanel(); setGroup(gTab + 1); return;
      case 'OK':
        // 两条路都走 inject.js 的 activate：
        //  · panel 态：面板收起→弹出；展开→fireClick 当前行→我们的 pick 分支
        //  · delete 态：面板必是展开的 → fireClick 当前行 → 我们的 del 分支
        T.activate();
        return;
      case 'BACK':
        if (mode === 'delete') { exitDelete(); openManage(); return; }
        if (T.isPanelOpen()) { T.closePanel(); return; }
        bridge('back');          // 交回 Android：退出确认 / 退出应用
        return;
    }
  }

  function key(name) {
    if (kbOpen) { kbKey(name); return; }
    if (mgOpen) { mgKey(name); return; }
    panelKey(name);
  }

  // ------------------------------------------------------------------
  // 对外（Android → JS）
  // ------------------------------------------------------------------

  /** 全量替换源列表。json: [{"n":名,"g":组,"u":地址,"h":{头}}] */
  function setSources(json) {
    try {
      var arr = (typeof json === 'string') ? JSON.parse(json) : json;
      SRC = (arr && arr.length) ? arr : [];
    } catch (e) { SRC = []; }

    // 清掉已经不存在的「播放失败」标记
    var keep = {};
    for (var i = 0; i < SRC.length; i++) keep[SRC[i].u] = 1;
    for (var u in bad) if (!keep[u]) delete bad[u];

    rebuildGroups();
    renderTabs();
    renderList();
    resetCursor(mode !== 'delete');   // 删除模式下停在原处，别把光标弹回顶部
    if (mgOpen) { if (kbOpen) buildKb(); else buildMenu(); }
  }

  function setPlaying(url) {
    playingUrl = String(url || '');
    markSelect();
    if (mgOpen && !kbOpen) buildMenu();
  }

  function setLan(text, err) {
    lanText = String(text || '');
    lanErr = String(err || '');
    if (mgOpen && !kbOpen) buildMenu();
  }

  /**
   * Android 侧告知「记住的远程清单地址」。
   * 它决定菜单里出不出现「刷新远程清单」，以及菜单头部要不要把那串地址显示出来。
   */
  function setRemote(url) {
    var u = String(url || '');
    if (u === remoteUrl) return;       // 没变就别重建 DOM（每次 pushSources 都会调到这里）
    remoteUrl = u;
    if (mgOpen && !kbOpen) buildMenu();
  }

  /** 键盘「保存」的结果。ok=false 时停在键盘上并给出原因，方便改了重试。 */
  function addResult(ok, msg) {
    if (!kbOpen) { toast(msg || (ok ? '已添加' : '添加失败')); return; }
    if (ok) {
      toast(msg || '已添加');
      closeKb();
    } else {
      kb.msg = msg || '添加失败';
      buildKb();
    }
  }

  function playFailed(url) {
    bad[String(url || '')] = 1;
    renderList();
    try { if (window.__yspTV && !window.__yspTV.isPanelOpen()) window.__yspTV.paint(false); } catch (e) {}
  }

  function playOk(url) {
    var u = String(url || '');
    if (bad[u]) { delete bad[u]; renderList(); }
  }

  function refresh() {
    rebuildGroups();
    renderTabs();
    renderList();
    resetCursor(mode !== 'delete');
  }

  /**
   * Android 侧读到的剪贴板内容（由 CustomActivity 的 clip() 回调）。
   *
   * 分派规则（两种粘贴内容，两条路）：
   *   · 单行 http(s):// 开头 → 当成「一份清单的网址或一路直播流」，
   *     走 add(name,url) —— Android 侧 SourceImport 会自己判断这是清单还是单流；
   *   · 别的（多行 / #EXTM3U / 一行地址但不是 http）→ 当成 m3u 文本，
   *     走 addText。
   * 判「是不是网址」而不是「有没有换行」：清单网址偶尔会被复制成一个带尾随换行的
   * 单行文本，反过来一份 m3u 也可能只有一行地址。所以先按协议头判，判不出再按文本。
   */
  function clipResult(text) {
    var t = String(text === undefined || text === null ? '' : text);
    var s = t.trim();
    if (!s) { toast('剪贴板是空的，先在手机上复制一段地址或清单'); return; }
    if (/^https?:\/\//i.test(s)) {
      var u = s.split(/[\r\n\s]/)[0];
      toast('正在导入剪贴板里的网址…');
      bridge('add', '', u);
      return;
    }
    toast('正在导入剪贴板里的内容…');
    bridge('addText', t);
  }

  window.__yspUI = {
    key: key,
    clipResult: clipResult,
    setSources: setSources,
    setPlaying: setPlaying,
    setLan: setLan,
    setRemote: setRemote,
    addResult: addResult,
    playFailed: playFailed,
    playOk: playOk,
    toast: toast,
    openManage: openManage,
    closeManage: closeManage,
    refresh: refresh,
    setGroup: setGroup,

    // ---- 给自动化测试用的探针（也方便现场排障）----
    isManageOpen: function () { return mgOpen; },
    isKbOpen: function () { return kbOpen; },
    isDeleteMode: function () { return mode === 'delete'; },
    mode: function () { return mode; },
    count: function () { return SRC.length; },
    /** 源名（来自 SRC，不受「面板是否可见」影响；labels() 会受影响） */
    names: function () {
      var out = [];
      for (var i = 0; i < SRC.length; i++) out.push(SRC[i].n || fallbackName(SRC[i].u));
      return out;
    },
    /** 源地址（测试要断言「删掉的是哪一条」） */
    urls: function () {
      var out = [];
      for (var i = 0; i < SRC.length; i++) out.push(SRC[i].u);
      return out;
    },
    /** 每条源带的请求头（测试要断言 m3u 里的 EXTVLCOPT 真的传下来了） */
    headers: function () {
      var out = [];
      for (var i = 0; i < SRC.length; i++) out.push(SRC[i].h || null);
      return out;
    },
    labels: function () {
      try { return window.__yspTV ? window.__yspTV.labels() : []; } catch (e) { return []; }
    },
    groups: function () {
      var out = [];
      for (var i = 0; i < GROUPS.length; i++) out.push(GROUPS[i].name);
      return out;
    },
    currentGroup: function () { return GROUPS[gTab] ? GROUPS[gTab].name : ''; },
    currentGroupIndex: function () { return gTab; },
    menuLabels: function () {
      var it = menuItems(), out = [];
      for (var i = 0; i < it.length; i++) out.push(it[i].label);
      return out;
    },
    menuIndex: function () { return mgIdx; },
    keyboard: function () {
      return { field: kb.field, r: kb.r, c: kb.c, name: kb.name, url: kb.url, msg: kb.msg };
    },
    playingUrl: function () { return playingUrl; },
    lanUrl: function () { return lanText; },
    lanError: function () { return lanErr; },
    remoteUrl: function () { return remoteUrl; },
    badUrls: function () {
      var out = [];
      for (var u in bad) out.push(u);
      return out;
    },
    /**
     * 调 Android 桥（测试用）。
     * ⚠️ 必须用 apply 原样转发参数个数 —— bridge 是按实参个数精确分派的，
     *    写成 bridge(fn,a,b) 会把 rpc('clip') 变成 yspCustom.clip(undefined,undefined)
     *    直接 "Method not found"。（这个坑真踩过：当时测试里的 seeds 静默不生效。）
     */
    rpc: function () { return bridge.apply(null, arguments); }
  };

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  function boot() {
    elList = el('yspList');
    elTabs = el('yspTabs');
    elPanel = el('yspPanel');
    elMg = el('ysp-manage');
    elMgCard = el('mgCard');
    elEmpty = el('yspEmpty');

    if (elTabs) elTabs.addEventListener('click', onTabsClick, false);
    if (elList) elList.addEventListener('click', onListClick, false);
    // 浮层点击（手机）。绑在 #ysp-manage 上做委托：菜单和键盘每次 buildXxx
    // 都整块重建，绑在重建出来的子元素上会在重建后失效。
    if (elMg) {
      elMg.addEventListener('click', onManagePointer, false);
      // 触屏上 click 有延迟、且容易被滚动/长按吃掉：认pointerdown 让点下去就有反应。
      // （重复触发由 dedupeTap 挡掉）
      elMg.addEventListener('pointerdown', function (e) {
        if (e && e.pointerType === 'touch') onManagePointer(e);
      }, false);
    }

    rebuildGroups();
    renderTabs();
    renderList();

    // 告诉 Android：页面就绪，可以把源列表推进来了
    bridge('manage', false);
    bridge('ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }

  // 视口尺寸变化（分辨率切换）后行高要重算
  try {
    window.addEventListener('resize', function () {
      try { if (window.__yspTV) { window.__yspTV.fitRows(); window.__yspTV.paint(false); } } catch (e) {}
    }, false);
  } catch (e) {}
})();
