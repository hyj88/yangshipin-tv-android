package com.ysptv.player;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 央视频 TV —— 只保留「视频播放器 + 选台列表」的电视端外壳。
 *
 * 设计要点：
 *  1. 必须伪装桌面 UA。站点首页脚本有 isMobile() 检查，Android UA 会被重定向到移动站(m.yangshipin.cn)，
 *     那样就没有电视直播布局了。
 *  2. 页面加载完成后注入 inject.css / inject.js：
 *     - CSS 用 position:fixed 让播放器(.tv-main-con-l)始终铺满整屏，
 *       选台面板(.tv-main-con-r)钉在【左侧】并默认 translateX(-101%) 滑出屏幕外；
 *       其余（顶栏/搜索/页脚/节目单/各种弹层）全部 display:none。
 *     - JS 提供方向键空间导航（WebView 不会自动给 div 列表移动焦点）。
 *  3. 交互模型：
 *     - 面板收起(默认)：上/下键 直接换到上/下一台，并弹出频道名气泡
 *     - 确认键：面板收起时弹出面板；面板展开时选中该台并收起
 *     - 面板展开：上/下移动光标（不换台），左/右切 CCTV/卫视，5 秒无操作自动隐藏
 *  4. 遥控器按键在 dispatchKeyEvent 里拦截，转成 JS 调用；不依赖网页自身的焦点体系。
 *
 * 横屏 / 全屏沉浸 / 设备判定等公共部分在基类 {@link TvShellActivity} 里。
 */
public class MainActivity extends TvShellActivity {

    private static final String HOME_URL = "https://www.yangshipin.cn/tv/home";

    /** 桌面 Chrome UA —— 这是能拿到电视直播版布局的关键 */
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            + "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    private FrameLayout root;
    private WebView web;
    private LinearLayout loading;
    private TextView loadingMsg;

    private String cssText;
    private String jsText;

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    private long lastBackTime = 0L;
    private boolean pageReady = false;

    /** 选台面板是否展开；由页面里的 __yspTV 经 yspBridge 同步过来 */
    private volatile boolean panelOpen = false;

    // =====================================================================
    // 「自定义源」入口
    //
    // 一共有四条路，按「用户能不能找到」排序：
    //   ① 【主入口】选台面板顶部常驻的「自定义源」一行 —— 确认键开面板就看得见，
    //      光标在第 0 台再按一次上键即可到达。这条是特意补上的，见下面那段说明。
    //   ② 蓝键（KEYCODE_PROG_BLUE）直达
    //   ③ 菜单键长按 700ms（短按已经在管选台面板了，不能再抢走）
    //   ④ Android TV 桌面上的「自定义源」卡片
    //
    // ⚠️ 为什么必须补 ① 这条（别再只靠桌面卡片）：
    //   CustomActivity 在 AndroidManifest 里确实注册成了第二个
    //   LEANBACK_LAUNCHER 入口，aapt2 dump badging 也确实能读到它；
    //   但 **Google TV 的桌面（com.google.android.tvlauncher）会把同一包名的多个
    //   leanback 入口按包聚合成一张卡片**，结果桌面上永远只有「央视频TV」一张，
    //   「自定义源」那张根本不出现（不是所有桌面都这样，Google TV 是）。
    //   ② ③ 又都是「要按对键才生效」的隐藏操作，用户不知道就等于没有。
    //   实测：直接 am start -n …/.CustomActivity 能正常起播，功能一直是好的，
    //   缺的只是【一个打开面板就看得到的入口】。
    //
    // ② ③ 的判定不用系统重复键（遥控器品牌千奇百怪，不一定给重复事件），
    // 自己在 ACTION_DOWN 起个定时器、ACTION_UP 取消，行为确定。
    // =====================================================================

    private static final long MENU_LONG_MS = 700L;
    private static final String PREF_MAIN = "ysp_main";
    /** 换过文案：键位提示改成指向面板里的可见入口，所以要让老用户再看一次 */
    private static final String K_CUSTOM_HINT = "custom_hint_shown2";

    private boolean menuLongFired = false;
    private final Runnable menuLongPress = new Runnable() {
        @Override public void run() {
            menuLongFired = true;
            openCustomSources();
        }
    };

    private class PanelBridge {
        @android.webkit.JavascriptInterface
        public void onPanel(boolean open) {
            panelOpen = open;
        }

        /**
         * 页面里那个常驻的「自定义源」入口被确认时走这里。
         *
         * ⚠️ 必须 post 回主线程：桥方法跑在 WebView 的 JavaBridge 线程上，
         *    startActivity 只能在主线程调（在桥线程上直接调会抛
         *    "Method setVisibility must be called on the main thread" 一类的错）。
         * ⚠️ 另外：addJavascriptInterface 是按【方法名 + 参数个数】匹配的，
         *    这里签名必须是「无参 void」，页面里才是 yspBridge.openCustom()。
         */
        @android.webkit.JavascriptInterface
        public void openCustom() {
            ui.post(new Runnable() {
                @Override public void run() {
                    openCustomSources();
                }
            });
        }

    }

    private final Handler ui = new Handler(Looper.getMainLooper());

    // =====================================================================
    // 生命周期
    // =====================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);   // 基类里做横屏 / 刘海 / 沉浸式
        setContentView(R.layout.activity_main);
        root = findViewById(R.id.root);
        web = findViewById(R.id.web);
        loading = findViewById(R.id.loading);
        loadingMsg = findViewById(R.id.loadingMsg);

        setupWebView();

        if (savedInstanceState == null) {
            web.loadUrl(HOME_URL);
        } else {
            web.restoreState(savedInstanceState);
        }

        // 兜底：定时补注入，应对 SPA 路由切换 / 站点改版导致的一次性注入失效
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                injectAll();
                maybeHintCustom();            // 一次性提示「长按菜单键」捷径
                if (pageReady) ui.postDelayed(this, 15000);
            }
        }, 12000);
    }

    @Override
    protected void onResume() {
        super.onResume();                     // 基类里重新锁横屏 + 收系统栏
        if (web != null) web.onResume();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        // ⚠️ 必须清掉 onCreate 里那个「每 15 秒自我重排」的补注入任务。
        //    它是 `if (pageReady) ui.postDelayed(this, 15000)`，只要页面加载成功过一次
        //    就永远续命 —— 不清的话，用户退回桌面之后 MainActivity 连同整个 WebView
        //    一直泄漏到进程被杀，而且 destroy 之后它还会跑 maybeHintCustom() →
        //    Toast.makeText(this) 拿一个已经 finish 的 Activity 当 context。
        ui.removeCallbacksAndMessages(null);
        if (web != null) {
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (web != null) web.saveState(outState);
    }

    // =====================================================================
    // WebView 初始化
    // =====================================================================

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadsImagesAutomatically(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setDefaultTextEncodingName("UTF-8");

        // 关键：伪装桌面 UA，否则被 isMobile() 判定并跳走
        s.setUserAgentString(DESKTOP_UA);

        // 直播流要能自动起播（API 17 起可用，minSdk 21 已覆盖，不需要守卫）
        s.setMediaPlaybackRequiresUserGesture(false);

        // 下面两个都是 API 21 的开关，minSdk 21 已覆盖，直接调用，不必再隔离成 Api21。
        // （minSdk 从 19 提到 21 后，Api21 隔离类已删除；API 28/30 的隔离仍然保留，见 Api28。）
        // 直播源里混着 http 片段，不放开会被拦成黑屏
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // 站点会在自己的域下挂第三方播放域，cookie 不放行会导致鉴权失败
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setBackgroundColor(0xFF000000);
        web.setHorizontalScrollBarEnabled(false);
        web.setVerticalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setFocusable(false);
        web.setFocusableInTouchMode(false);

        // debug 包打开 WebView 远程调试；release 包自动关闭
        // （setWebContentsDebuggingEnabled 自 API 19 起可用，minSdk 21 已覆盖，不需要守卫）
        boolean debuggable = (getApplicationInfo().flags
                & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        // 极简 JS 桥：只为把「选台面板是否展开」同步回 Java。
        // 返回键要知道面板状态才好决定是「收起面板」还是「进入退出倒计时」——
        // evaluateJavascript 是异步的，赶不上同步的按键分发。
        // 该桥只有一个接收 boolean 的方法，不暴露任何能力，页面即使乱调也无副作用。
        web.addJavascriptInterface(new PanelBridge(), "yspBridge");

        web.setWebViewClient(new WebViewClient() {

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                // 站内导航留在 WebView；站外一律拦掉（电视端没有浏览器可跳）
                return !(url != null && (url.contains("yangshipin.cn") || url.contains("cctv.cn")
                        || url.contains("cctv.com")));
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                pageReady = true;
                injectAll();
                // SPA 首屏渲染时序不定，多补几次
                ui.postDelayed(new Runnable() { @Override public void run() { injectAll(); } }, 800);
                ui.postDelayed(new Runnable() { @Override public void run() { injectAll(); } }, 2500);
                ui.postDelayed(new Runnable() { @Override public void run() { injectAll(); } }, 6000);
                ui.postDelayed(new Runnable() { @Override public void run() { injectAll(); ensurePlaying(); } }, 12000);
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                showError("网络错误(" + code + ")\n" + desc);
            }

            // ⚠️ 不要在这里重写 API 23 的
            //    onReceivedError(WebView, WebResourceRequest, WebResourceError)。
            //    那个重载的参数类型（WebResourceRequest/WebResourceError）在 API 23 才存在，
            //    而匿名类是 MainActivity 的一部分，5.0/5.1（API 21/22）的机器在**类加载**时
            //    就会去解析方法签名 → NoClassDefFoundError。
            //    （minSdk 从 19 提到 21 并【没有】解锁这条：隔离线跟着 minSdk 走，21 < 23。）
            //    好在框架里那个新方法的默认实现会把主框架错误转发到上面这个老方法，
            //    所以不重写不丢行为，还省了一个隐患。

            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler handler, android.net.http.SslError error) {
                Log.w(TAG, "SSL error: " + error);
                handler.cancel();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                view.setBackgroundColor(0xFF000000);
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                web.setVisibility(View.GONE);
                hideSystemUi();
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                web.setVisibility(View.VISIBLE);
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
                hideSystemUi();
            }

            // ⚠️ 不要重写 onPermissionRequest(PermissionRequest)。
            //    minSdk 提到 21 之后，这个 API 21 的类型倒是能用了（不再是类解析风险），
            //    但 WebChromeClient 里那个方法的默认实现本来就是 request.deny()，
            //    重写它等于抄一遍默认行为，白担风险。

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "[web] " + m.message() + " @" + m.lineNumber());
                return true;
            }
        });

        // 载入遮罩：有画面后淡出
        web.setAlpha(0f);
    }

    // =====================================================================
    // 注入
    // =====================================================================
    // readAsset() 在基类 TvShellActivity 里

    private void js(final String code) {
        if (web == null) return;
        ui.post(new Runnable() {
            @Override public void run() {
                try { web.evaluateJavascript(code, null); } catch (Exception e) { Log.w(TAG, "js err", e); }
            }
        });
    }

    /** 注入样式 + 交互脚本（幂等，可反复调用） */
    private void injectAll() {
        if (web == null) return;
        if (cssText == null || cssText.isEmpty()) cssText = readAsset("inject.css");
        if (jsText == null || jsText.isEmpty()) jsText = readAsset("inject.js");
        if (cssText.isEmpty() && jsText.isEmpty()) return;

        // 用 JSON 字符串字面量承载 CSS，避免引号/换行转义问题
        String cssLiteral = JSONObject.quote(cssText);
        String styleRunner =
                "(function(){try{var id='ysp-tv-style';"
                + "var e=document.getElementById(id);"
                + "if(!e){e=document.createElement('style');e.id=id;"
                + "(document.head||document.documentElement).appendChild(e);}"
                + "e.textContent=" + cssLiteral + ";"
                + "}catch(x){console.log('ysp css err',x);}})();";

        js(styleRunner);

        // 告诉页面这是不是触摸设备：手机要开触摸手势层 + 首次手势提示，
        // 电视上那套手势完全用不到（永远收不到 touch 事件）。
        // 必须在 inject.js 之前注入 —— inject.js 是幂等的，首次执行后不再重跑。
        js("window.__yspTV_TOUCH=" + (!isTv()) + ";");

        if (!jsText.isEmpty()) js(jsText);

        // 有内容后淡出遮罩
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                if (web != null && web.getAlpha() < 1f) {
                    web.animate().alpha(1f).setDuration(350).start();
                    if (loading != null) loading.setVisibility(View.GONE);
                }
            }
        }, 1200);
    }

    /** 确保直播在播放（部分机型仍需显式触发一次 play） */
    private void ensurePlaying() {
        js("(function(){try{var v=document.querySelector('.tv-main-con-l video');"
           + "if(v&&v.paused){v.muted=false;var p=v.play();if(p&&p.catch)p.catch(function(){});}"
           + "}catch(e){}})();");
    }

    private void showError(final String msg) {
        ui.post(new Runnable() {
            @Override public void run() {
                if (loading == null) return;
                loading.setVisibility(View.VISIBLE);
                if (loadingMsg != null) loadingMsg.setText(msg + "\n\n请检查网络后按「确认」重试");
                web.setAlpha(0f);
                pageReady = false;
            }
        });
    }

    // =====================================================================
    // 浏览器能力体检（已于 1.6 删除）
    //
    // 这里原来有一整条「内核能力体检」降级路径：页面里探测 MSE / WebAssembly / fetch，
    // 缺哪样就把遮罩改成一页说明。它存在的唯一理由是 minSdk 21 ——
    // 5.0/6.0 的机器上「装得上、但 WebView 可能还停在 Chromium 37」，
    // 得有人把「为什么黑屏」说清楚。
    //
    // 1.6 把 minSdk 提到 24（Android 7.0）之后这条路径一并删掉：
    //   7.0 以下装不上，装得上的内核都远高于 Chrome 57（2017 年），
    //   继续养着一页提示 + 一整套老设备回归用例不划算。
    //   真要再查「内核到底缺什么」，用 tools/browser_capability_probe.mjs（离线研究用，
    //   不进 APK）；那份能力摘除实验的结论（最低 Chrome 57）写在 build.gradle 的
    //   minSdk 注释里，别让它跟着文件一起消失。
    // =====================================================================

    // =====================================================================
    // 遥控器按键
    // =====================================================================

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        int action = e.getAction();

        // ---- 菜单键：短按开关选台面板，长按 700ms 进「自定义源」----
        if (code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_INFO) {
            if (action == KeyEvent.ACTION_DOWN) {
                if (e.getRepeatCount() == 0) {
                    menuLongFired = false;
                    ui.removeCallbacks(menuLongPress);
                    ui.postDelayed(menuLongPress, MENU_LONG_MS);
                }
                return true;
            }
            ui.removeCallbacks(menuLongPress);
            if (!menuLongFired) js("window.__yspTV&&__yspTV.togglePanel()");
            menuLongFired = false;
            return true;
        }

        // ---- 蓝键：直接进「自定义源」----
        if (code == KeyEvent.KEYCODE_PROG_BLUE) {
            if (action == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) openCustomSources();
            return true;
        }

        // ---- 载入失败时，确认键 = 重试 ----
        if (!pageReady && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER)
                && action == KeyEvent.ACTION_DOWN) {
            web.reload();
            return true;
        }

        if (action == KeyEvent.ACTION_DOWN) {
            switch (code) {
                case KeyEvent.KEYCODE_DPAD_UP:
                case KeyEvent.KEYCODE_CHANNEL_UP:
                    js("window.__yspTV&&__yspTV.move(-1)");
                    return true;

                case KeyEvent.KEYCODE_DPAD_DOWN:
                case KeyEvent.KEYCODE_CHANNEL_DOWN:
                    js("window.__yspTV&&__yspTV.move(1)");
                    return true;

                case KeyEvent.KEYCODE_DPAD_LEFT:
                    js("window.__yspTV&&__yspTV.switchTab(0)");
                    return true;

                case KeyEvent.KEYCODE_DPAD_RIGHT:
                    js("window.__yspTV&&__yspTV.switchTab(1)");
                    return true;

                case KeyEvent.KEYCODE_DPAD_CENTER:
                case KeyEvent.KEYCODE_ENTER:
                case KeyEvent.KEYCODE_NUMPAD_ENTER:
                    // 面板收起时 = 弹出左侧选台面板；面板展开时 = 选中该台并收起
                    if (e.getRepeatCount() == 0) {
                        js("window.__yspTV&&__yspTV.activate()");
                    }
                    return true;

                case KeyEvent.KEYCODE_PROG_RED:
                    js("window.__yspTV&&__yspTV.togglePanel()");
                    return true;

                case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
                case KeyEvent.KEYCODE_MEDIA_PLAY:
                case KeyEvent.KEYCODE_MEDIA_PAUSE: {
                    String fn = (code == KeyEvent.KEYCODE_MEDIA_PAUSE) ? "pause()" : "paused?play():pause()";
                    js("(function(){var v=document.querySelector('.tv-main-con-l video');if(v){try{v."
                       + fn + ";}catch(e){}}})();");
                    return true;
                }

                case KeyEvent.KEYCODE_BACK:
                    // 面板展开时，返回键先收起面板（符合电视端的「返回 = 关掉当前浮层」直觉）
                    if (panelOpen) {
                        panelOpen = false;
                        lastBackTime = 0L;
                        web.evaluateJavascript(
                                "(function(){try{window.__yspTV.closePanel();}catch(e){}})();", null);
                        return true;
                    }
                    // 面板已收起：连按两次退出，避免误触
                    long now = System.currentTimeMillis();
                    if (now - lastBackTime < 2000) {
                        finish();
                    } else {
                        lastBackTime = now;
                        Toast.makeText(this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
                    }
                    return true;

                default:
                    break;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    // =====================================================================
    // 进入「自定义源」
    // =====================================================================

    private void openCustomSources() {
        try {
            startActivity(new Intent(this, CustomActivity.class));
        } catch (Throwable t) {
            Log.w(TAG, "打开自定义源失败", t);
            Toast.makeText(this, "打不开自定义源页面", Toast.LENGTH_SHORT).show();
        }
    }

    /**
     * 第一次装好后提示一次「自定义源在哪」。
     * 只提示一次 —— 电视 App 每次启动都弹提示是灾难。
     * 文案指向面板顶部那个看得见的入口，而不是只有老用户才知道的蓝键。
     */
    private void maybeHintCustom() {
        try {
            android.content.SharedPreferences p = getSharedPreferences(PREF_MAIN, MODE_PRIVATE);
            if (p.getBoolean(K_CUSTOM_HINT, false)) return;
            p.edit().putBoolean(K_CUSTOM_HINT, true).apply();
        } catch (Throwable t) {
            return;
        }
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                Toast.makeText(MainActivity.this,
                        "按确认键打开选台面板，最上方「自定义源」可导入自己的 m3u8 源",
                        Toast.LENGTH_LONG).show();
            }
        }, 6000);
    }
}
