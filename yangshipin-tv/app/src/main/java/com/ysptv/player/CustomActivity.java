package com.ysptv.player;

import android.annotation.SuppressLint;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.widget.VideoView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 自定义源播放器 —— 播放用户自己导入的 m3u8 / mp4 地址。
 *
 * ==========================================================================
 * 一、为什么用原生 VideoView，而不是在 WebView 里放 hls.js
 * ==========================================================================
 * Android 的 WebView 【没有原生 HLS】，<video src="x.m3u8"> 什么都不会发生；
 * 要在网页里播 m3u8 只能用 hls.js，而 hls.js 依赖 MSE（MediaSource）。
 * 这条路实测的结果（见 tools/hls_probe.mjs 的探测记录）：
 *   · Chromium 12x（API 34）：hls.js 1.5.20 与 0.14.17 都能完美播放；
 *   · Chromium 37（API 21）：1.5.20 直接 internalException 挂掉；
 *     0.14.17 能解出 1280×720、readyState=4，但画面始终出不来（MSE 与解码器对不上）。
 * 也就是说「靠网页播 m3u8」在中低端电视盒子上是靠不住的。
 *
 * 原生 MediaPlayer 则完全不同：HLS 解封装是系统框架里的（libstagefright），
 * 国内电视盒子/电视 SoC（Amlogic、MTK、海思）普遍还有硬解 HLS 的通路，
 * 不需要 MSE、不需要 WebAssembly，也不需要联网下载任何第三方 JS。
 * 所以主路径就用它，且整个工程仍然保持「零第三方依赖」。
 *
 * 代价与已知边界（诚实列在这，免得以后误判）：
 *   · fMP4（#EXT-X-MAP + .m4s）分片的 HLS 要 Android 8 以上的 MediaPlayer 才稳；
 *   · AES-128 加密的流，取密钥时用的是同一套请求头，一般能过，个别 CDN 会拦；
 *   · 极少数源只吃 hls.js 那套（比如需要自定义 XHR 行为）。
 *   真遇到这些，再补一条「hls.js 回落」即可 —— 布局里给这层留了位置，
 *   但代码不预先引入没有验证过的第三方库。
 *
 * ==========================================================================
 * 二、为什么面板是一个【透明 WebView】
 * ==========================================================================
 * 左侧选台面板的观感（行高凑整数、光标态、换台气泡、手机触摸手势、5 秒自动隐藏）
 * 在主界面上已经调好并测过（device_test 80/80、phone_touch 22/22）。
 * 与其用原生控件再写一套、还写不到一样的手感，不如把 assets/custom.html
 * 造成和央视频首页一样的 DOM 形状，让 inject.css / inject.js 原样复用。
 * 所以本页的 WebView 必须【全透明】，面板之外一个像素都不许画 —— 否则会把
 * 底下的 VideoView 盖掉（custom.css §1 就是干这个的）。
 *
 * ==========================================================================
 * 三、按键
 * ==========================================================================
 *   上/下        面板收起 = 换台；面板展开 = 移动光标
 *   确认         面板收起 = 弹出面板；展开 = 选中该台
 *   左/右        切换分组（全部 / 央视 / 卫视 …）
 *   菜单 / 信息  开关「源管理」（局域网导入、剪贴板粘贴、屏上输入、删除、清空）
 *   蓝键         直接打开「源管理」
 *   播放/暂停    暂停 / 继续
 *   返回         有浮层先关浮层；否则连按两次退出
 *
 * 所有按键都转发给页面里的 __yspUI.key()，由它按「当前所处的层」分发
 * （面板 / 菜单 / 键盘 / 删除模式）——Java 侧不需要知道用户正停在哪一层。
 *
 * ==========================================================================
 * 四、镜像自动顺延（v1.4）
 * ==========================================================================
 * 真实聚合清单里同一个台常有好几路地址（cn_all.m3u8：181 条压在 62 个台上，
 * 43 个台是多路的），而这类清单约 1/3 是死链。以前每一路都要用户自己往下换，
 * 现在失败时自动试同台的下一路 —— 归一化与选路全在 {@link Mirrors} 里，
 * 本类只负责「什么时候试、怎么提示、什么时候收手」。
 *
 * 收手条件（两个任一满足即停）：试满 {@link Mirrors#MAX_ATTEMPTS} 路，
 * 或整轮超过 {@link Mirrors#WALK_BUDGET_MS}。
 *
 * ⚠️ 三条容易踩的坑，都写在各自字段的注释里，这里只列名字：
 *    ① 试过的记录【不能】在起播成功时清空 —— 那会造成镜像之间来回弹；
 *    ② 起播成功时【必须】重置时间预算 —— 否则一条流播十分钟后断掉时，顺延会静默失效；
 *    ③ 推进【必须】延迟出去 —— failWith 可能是从 MediaPlayer 的 onError 里进来的。
 */
public class CustomActivity extends TvShellActivity {

    private static final String PANEL_URL = "file:///android_asset/custom.html";

    /** 起播超时。等不到 onPrepared 就认为这条源不通，别让用户对着黑屏干等 */
    private static final int PREPARE_TIMEOUT_MS = 15000;

    private static final String PREF_HINT = "ysp_custom";
    private static final String K_HINT_SHOWN = "hint_shown";

    private FrameLayout root;
    private VideoView video;
    private WebView panelWeb;
    private LinearLayout status;
    private TextView statusTitle;
    private TextView statusMsg;

    private final Handler ui = new Handler(Looper.getMainLooper());

    private List<Source> sources;
    private Source current;

    private volatile boolean pageReady = false;   // 页面脚本已就绪，可以收 setSources 了
    private volatile boolean playFailed = false;  // 当前处于「播不出来」状态
    private volatile boolean manageOpen = false;  // 由页面同步过来，按键要用
    /** 零源常驻提示的文案（title, msg）；null = 当前没有这条提示 */
    private volatile String[] zeroHint = null;
    private volatile boolean playerDead = false;  // VideoView 里的 MediaPlayer 已不可用，必须整个换掉
    private boolean started = false;              // 已经播过至少一条

    private long lastBackTime = 0L;
    private long pausedAt = 0L;

    // ---- 镜像自动顺延的状态（策略与归一化都在 Mirrors 里，这里只管计时与推进）----

    /** 本次会话里失败过的地址。刷新顺延顺序用，也是「别在已知死地址上白耗时间」的依据 */
    private final Set<String> sessionBad = new LinkedHashSet<>();

    /**
     * 本轮已经试过的地址（含用户点的那一路）。
     * ⚠️ 起播成功时【不清空】它 —— 清空会导致「A 起播→失败→B 起播→失败→A…」
     *    这种在同一族镜像之间来回弹的循环。试过的记录本身就是这个循环的刹车。
     *    只在「用户主动选 / 换到别的台」时清。
     */
    private final Set<String> mirrorTried = new LinkedHashSet<>();

    /** 本轮顺延所属的台（归一化 key）。换台或用户重选 → key 变化 = 重开一轮 */
    private String mirrorKey = "";

    /** 这个台一共有几路（含自己）。只用于提示文案，不影响选路 */
    private int mirrorTotal = 1;

    /**
     * 本轮顺延的开始时间，用于 {@link Mirrors#WALK_BUDGET_MS} 总时长预算。
     *
     * ⚠️⚠️ 这个「开始时间」指的是**这一串失败里的第一次失败**，不是「起播成功」。
     *     v1.4 第一版把它重置在 {@code onPrepared}（起播成功那一刻），是个真 bug：
     *     用户看满十分钟之后流断了，此时 {@code now - mirrorWalkStart} 已经十几分钟，
     *     远超 40 秒预算 → 一路都不试，直接弹「无法播放」。
     *     也就是这个「自动顺延」只在开播后 40 秒内失败才生效 —— 而真实断流
     *     绝大多数发生在看了好几分钟之后。**功能等于只在测试场景里活着**
     *     （测试用的死链都是「一点就死」，正好落在窗口内，所以全绿）。
     *
     *     正确语义：预算从「这一轮第一次失败」起算，由 {@link #mirroring} 判定是不是第一次。
     */
    private long mirrorWalkStart = 0L;

    /**
     * 「这一串连续失败已经开始了吗」—— 本轮第一次失败时置起，起播成功或重开一轮时清掉。
     *
     * 存在的理由就是上面 {@link #mirrorWalkStart} 那条注释：只在**第一次**失败时
     * 给预算计时，之后的失败累加计时（这样 40 秒才真的是「整轮顺延的总时长」）。
     */
    private boolean mirroring = false;

    /** 起播世代号：每次 play() 自增。延迟推进靠它判断「这一轮是否已作废」 */
    private long playGen = 0L;

    /**
     * 「下一次 play() 是自动顺延换过来的」标记，由推进任务在调用 play() 前置起。
     *
     * 为什么要一个显式标记，而不是在 play() 里按 mirrorTried.size() 猜：
     *   onResume 重新贴直播时也会调 play(current, false)，那时 mirrorTried 里
     *   可能已经躺着好几条了 —— 按数量猜会把「重新连接」也当成顺延，
     *   于是状态层不更新，用户看到的是上一次失败留下的旧文字。
     */
    private boolean nextPlayIsHop = false;

    private LanImportServer lan;
    private volatile boolean lanStarting = false;
    private volatile String lanErr = "";

    // =====================================================================
    // 与页面之间的桥（页面 → Java）
    //
    // ⚠️ 这些方法运行在 WebView 的 JavaBridge 线程上，不是主线程。
    //    凡是要碰界面的，一律 ui.post 回主线程。
    // ⚠️ 桥不暴露任何文件/网络/系统能力，只有「改本 App 自己的源列表」这一件事。
    // =====================================================================

    private final class UiBridge {

        /** 页面脚本就绪 */
        @android.webkit.JavascriptInterface
        public void ready() {
            ui.post(new Runnable() { @Override public void run() { onPageReady(); } });
        }

        /** 用户在面板里选定了一条源 */
        @android.webkit.JavascriptInterface
        public void pick(final String url) {
            ui.post(new Runnable() {
                @Override public void run() {
                    Source s = findSource(url);
                    if (s != null) play(s, true);
                }
            });
        }

        /** 删除模式里删掉一条 */
        @android.webkit.JavascriptInterface
        public void del(final String url) {
            ui.post(new Runnable() {
                @Override public void run() {
                    if (current != null && url != null && url.equals(current.url)) {
                        toastInPage("正在播放的这条不能删，先切到别的台");
                        return;
                    }
                    int before = sources.size();
                    java.util.List<Source> keep = new java.util.ArrayList<>();
                    for (Source s : sources) if (!s.sameAsUrl(url)) keep.add(s);
                    if (keep.size() == before) return;
                    SourceStore.save(CustomActivity.this, keep);
                    reload();
                    toastInPage("已删除 1 条（剩 " + keep.size() + " 条）");
                }
            });
        }

        /** 屏上键盘保存：新增一条。地址也可能是一份清单的网址 —— 由 SourceImport 判断 */
        @android.webkit.JavascriptInterface
        public void add(final String name, final String url) {
            runImport("屏上键盘添加", new ImportJob() {
                @Override public SourceImport.Result run(SourceImport imp) {
                    return imp.importUrl(url, name);
                }
            }, true);
        }

        /** 重新抓一次记住的远程清单（电视上的「刷新远程清单」→ v1.11 起是【同步】） */
        @android.webkit.JavascriptInterface
        public void refresh() {
            runImport("刷新远程清单", new ImportJob() {
                @Override public SourceImport.Result run(SourceImport imp) {
                    return imp.refreshRemote();
                }
            }, false);
        }

        /**
         * 退订这份清单：删掉它带来的全部条目 + 忘掉地址（v1.11）。
         *
         * ⚠️ 「正在播的那条正好属于这份清单」是必须先处理的：
         *    单条删除（del）会拦下并提示先切台，但退订一下删几十上百条，
         *    拦下来等于让用户先记住哪个台在被播 —— 太不近人情。
         *    这里的选择是：先自动切到列表里第一条还在的台再退订。
         */
        @android.webkit.JavascriptInterface
        public void unlist() {
            runImport("退订清单", new ImportJob() {
                @Override public SourceImport.Result run(SourceImport imp) {
                    return imp.unlistRemote();
                }
            }, false);
        }

        /** 清空全部 */
        @android.webkit.JavascriptInterface
        public void clear() {
            ui.post(new Runnable() {
                @Override public void run() {
                    SourceStore.clear(CustomActivity.this);
                    reload();
                    toastInPage("已清空。按「菜单」键可以重新导入");
                }
            });
        }

        /**
         * 读系统剪贴板，回给页面。
         *
         * 为什么要它：电视上根本没有「粘贴」这个动作 —— 屏上键盘是一个字符一个字符敲的，
         * 一份清单网址动辄六七十个字符。所以「复制到剪贴板 → 电视上粘」是唯一顺手的路，
         * 而这一条以前只能靠手机打开局域网页面去粘贴（电视端完全没有）。
         *
         * 读剪贴板必须回主线程：{@code getSystemService} / {@code getPrimaryClip}
         * 在桥线程上调不保证，而且顺带能把 ANR 风险一起挪走。
         * 用 {@code JSONObject.quote} 转义：剪贴板里是什么都有（换行、引号、&、反斜杠），
         * 拼进 JS 字面量必须转义，否则整段脚本会语法错误、而且错误信息很难看懂。
         */
        @android.webkit.JavascriptInterface
        public void clip() {
            ui.post(new Runnable() {
                @Override public void run() {
                    String t = readClipboard();
                    js("__yspUI&&__yspUI.clipResult(" + org.json.JSONObject.quote(t) + ")");
                }
            });
        }

        /** 剪贴板里是一份 m3u 文本（多行 / #EXTM3U）时走这条 */
        @android.webkit.JavascriptInterface
        public void addText(final String text) {
            runImport("剪贴板导入", new ImportJob() {
                @Override public SourceImport.Result run(SourceImport imp) {
                    return imp.importText(text, null);
                }
            }, false);
        }

        /** 管理浮层打开 → 开局域网服务 */
        @android.webkit.JavascriptInterface
        public void lanStart() {
            ui.post(new Runnable() { @Override public void run() { startLan(); } });
        }

        @android.webkit.JavascriptInterface
        public void lanStop() {
            ui.post(new Runnable() { @Override public void run() { stopLan(); } });
        }

        /** 页面同步「管理浮层是否展开」—— 菜单键要靠它决定是开还是关 */
        @android.webkit.JavascriptInterface
        public void manage(final boolean open) {
            manageOpen = open;
            // 零源提示与浮层不能同屏（会叠字），浮层一变就要重判显不显示
            applyZeroHintVisibility();
        }

        /** 页面把返回键交回来 = 它已经没有浮层可关了，轮到 Activity 决定退出 */
        @android.webkit.JavascriptInterface
        public void back() {
            ui.post(new Runnable() {
                @Override public void run() {
                    long now = System.currentTimeMillis();
                    if (now - lastBackTime < 2000) {
                        finish();
                    } else {
                        lastBackTime = now;
                        Toast.makeText(CustomActivity.this, "再按一次返回键退出", Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        /** 页面日志转发到 logcat（排障用：adb logcat -s YSPTV） */
        @android.webkit.JavascriptInterface
        public void log(String msg) {
            Log.d(TAG, "[custom] " + msg);
        }
    }

    // =====================================================================
    // 生命周期
    // =====================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_custom);

        root = findViewById(R.id.root);
        video = findViewById(R.id.video);
        panelWeb = findViewById(R.id.panelWeb);
        status = findViewById(R.id.status);
        statusTitle = findViewById(R.id.statusTitle);
        statusMsg = findViewById(R.id.statusMsg);

        sources = SourceStore.load(this);

        setupVideo();
        setupPanel();

        panelWeb.loadUrl(PANEL_URL);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (panelWeb != null) panelWeb.onResume();
        // 从后台回来：直播要重新贴到「当前时刻」，在暂停点继续看会落后一大截。
        // 只在「确实停了一会儿」时才重载，避免刚起播就被自己打断。
        if (current != null && !playFailed && video != null && !video.isPlaying()
                && System.currentTimeMillis() - pausedAt > 3000) {
            play(current, false);
        }
    }

    @Override
    protected void onPause() {
        pausedAt = System.currentTimeMillis();
        // ⚠️ 必须把排队中的回调清掉。起播看门狗（15s）和镜像顺延（250ms）都是
        //    postDelayed 的，不清的话用户按 HOME 之后，看门狗照样在后台触发
        //    failWith → 顺延 → video.start() —— 声音从后台冒出来，而且没有 Surface，
        //    表现是「退出/切后台之后电视自己响」，只能杀进程。
        ui.removeCallbacksAndMessages(null);
        // ⚠️ 不能写成 `if (video.isPlaying()) video.pause()`。
        //    VideoView.isPlaying() 在「正在起播 / 缓冲中」时是 **false**，
        //    于是 pause() 根本不会被调用；而 mTargetState 只在 pause() 内部
        //    才被设成 PAUSED —— 不调，它就还是 PLAYING，prepared 一到就自己 start()。
        //    也就是「缓冲中切后台 = 后台自动播放」。
        //    pause() 内部自己有 isInPlaybackState() 守卫，直接调是安全的。
        if (video != null) {
            try { video.pause(); } catch (Throwable ignored) {}
        }
        if (panelWeb != null) panelWeb.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        // ⚠️ 同上，而且要更彻底：Activity 已经 finish 了，那些延迟任务还在队列里，
        //    15 秒后照跑一遍 failWith + 顺延 + video.start()，
        //    结果就是「退出之后电视自己响」，用户只能去杀进程。
        ui.removeCallbacksAndMessages(null);
        stopLan();
        if (video != null) {
            try { video.stopPlayback(); } catch (Throwable ignored) {}
        }
        if (panelWeb != null) {
            panelWeb.removeJavascriptInterface("yspCustom");
            root.removeView(panelWeb);
            panelWeb.destroy();
            panelWeb = null;
        }
        super.onDestroy();
    }

    // =====================================================================
    // 播放
    // =====================================================================

    private void setupVideo() {
        // ⚠️ 每次换台都 stopPlayback() 重建 MediaPlayer。
        //    复用同一个 MediaPlayer 连续 setDataSource 是「第二条流再也播不出来」
        //    这类玄学问题最常见的来源，宁可多花几毫秒重新初始化。
        video.setOnPreparedListener(new android.media.MediaPlayer.OnPreparedListener() {
            @Override public void onPrepared(android.media.MediaPlayer mp) {
                ui.removeCallbacks(prepareTimeout);
                hideStatus();
                playFailed = false;
                playerDead = false;      // 这一台播放器能干活，不用换
                started = true;
                String u = (current == null) ? "" : current.url;
                js("__yspUI&&__yspUI.playOk(" + JSONObject.quote(u) + ")");

                // 这一路是自动顺延换来的 → 得说一声。台「自己变了」而不给任何解释，
                // 用户会以为是串台。
                if (mirrorTried.size() > 1) {
                    final String nm = (current == null) ? "" : current.display();
                    toastInPage("这一路不通，已自动换到「" + nm + "」的第 "
                            + mirrorTried.size() + " 路地址");
                }
                // 出画了 = 这一串失败结束了。下一次失败要【重新】起算 40 秒预算
                // （见 mirrorWalkStart 的注释：预算起点是「第一次失败」，不是「起播成功」——
                //   写在这里就等于预算永远从出画那一刻算起，看十分钟再断流就超预算了）。
                // ⚠️ 但【不要】清 mirrorTried：试过的记录是防「镜像之间来回弹」的刹车。
                mirroring = false;

                log("起播成功: " + (current == null ? "?" : current.display())
                        + (mirrorTried.size() > 1 ? "（本轮第 " + mirrorTried.size() + " 路）" : ""));
            }
        });

        video.setOnErrorListener(new android.media.MediaPlayer.OnErrorListener() {
            @Override public boolean onError(android.media.MediaPlayer mp, int what, int extra) {
                // 返回 true = 已经处理，别再弹系统那个「无法播放该视频」的框
                ui.removeCallbacks(prepareTimeout);
                // mediacodec / mediaserver 进程挂掉（what=100）：播放器对象本身已经废了，
                // stopPlayback() 里的 reset() 会抛 ISE 并把坏对象留在 VideoView 里 ——
                // 记下来，下次起播前换个全新的 VideoView（见 rebuildVideo 的说明）。
                if (what == android.media.MediaPlayer.MEDIA_ERROR_SERVER_DIED) playerDead = true;
                failWith("解码/加载失败（what=" + what + " extra=" + extra + "）");
                return true;
            }
        });

        video.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
            @Override public void onCompletion(android.media.MediaPlayer mp) {
                // 点播流播完了。直播流不会走到这。
                if (playFailed) return;
                showStatus("播放结束", (current == null ? "" : current.display())
                        + "\n\n这是一条点播（有头有尾）的流。\n按「确认」重头再播，按「菜单」换一条源。");
                playFailed = true;
            }
        });

        video.setOnInfoListener(new android.media.MediaPlayer.OnInfoListener() {
            @Override public boolean onInfo(android.media.MediaPlayer mp, int what, int extra) {
                if (what == android.media.MediaPlayer.MEDIA_INFO_BUFFERING_START) {
                    showStatus("缓冲中…", current == null ? "" : current.display());
                } else if (what == android.media.MediaPlayer.MEDIA_INFO_BUFFERING_END
                        || what == android.media.MediaPlayer.MEDIA_INFO_VIDEO_RENDERING_START) {
                    hideStatus();
                    playFailed = false;
                }
                return false;
            }
        });
    }

    private final Runnable prepareTimeout = new Runnable() {
        @Override public void run() {
            if (!pageReady) return;
            try { video.stopPlayback(); } catch (Throwable ignored) {}
            failWith("等 " + (PREPARE_TIMEOUT_MS / 1000) + " 秒还没拿到画面。"
                    + "地址可能已经失效、需要特定网络环境，或者这台设备解不了它的封装格式。");
        }
    };

    /** 播一条源。userPicked=true 表示是用户主动选的（要记住、给反馈） */
    private void play(Source s, boolean userPicked) {
        if (s == null || s.url == null || s.url.isEmpty()) return;

        // 上一次把播放器弄死了（mediaserver 崩溃 / setVideoURI 抛异常）——
        // 先换一个全新的 VideoView，否则下面的 setVideoURI 还是会抛同一个 ISE，
        // 「按确认重试」就永远重试不成功。换完 video 字段指向新的那个。
        if (playerDead) rebuildVideo();

        current = s;
        playFailed = false;
        started = true;
        // ⚠️ 早一点自增：先把上一轮还在路上的「延迟顺延」作废掉。
        //    不加这一下的话，用户在失败后 250ms 内自己选了另一条源，
        //    那个延迟任务还会把台拽回它挑的那一路。
        playGen++;

        // ---- 镜像顺延：开新一轮，还是接着往下走 ----
        // 用户主动选一条、或换到了另一个台 → 重开一轮；
        // 否则我们正处在同一轮的自动顺延里，只是继续往下试。
        String mk = Mirrors.key(s);
        if (userPicked || !mk.equals(mirrorKey) || mirrorTried.isEmpty()) {
            mirrorKey = mk;
            mirrorTried.clear();
            mirrorTotal = Mirrors.count(sources, s);
            // 新一轮：整串失败还没开始，下一次失败要重新起算 40 秒预算
            mirroring = false;
        }
        mirrorTried.add(s.url);

        // 这一次是「被自动顺延换过来的」吗？由推进任务显式标记，不靠 mirrorTried 猜
        // （onResume 重新贴直播时也会走到这里，那时 mirrorTried 可能已经有几条了，
        //   按数量猜会把「重新连接」也当成顺延）。
        boolean mirrorHop = nextPlayIsHop && !userPicked;
        nextPlayIsHop = false;

        ui.removeCallbacks(prepareTimeout);
        try { video.stopPlayback(); } catch (Throwable ignored) {}
        // ⚠️ 是顺延换过来的话【不能】在这里盖状态层。
        //    failWith 刚写上去的三行（第几路不通 / 为什么 / 按「菜单」键可以直接换别的台）
        //    是用户唯一能看出「台为什么自己变了」的地方 ——
        //    而推进只隔 250ms，旧写法会让它只闪一下就被「正在连接…」顶掉，等于没写。
        //    让它一直挂着，直到这一路出画（hideStatus）或又失败（failWith 重写）。
        if (!mirrorHop) {
            hideStatus();
            showStatus("正在连接…", s.display() + "\n" + Source.shortUrl(s.url));
        }

        try {
                Uri u = Uri.parse(s.url);
                // 历史：setVideoURI(Uri, Map) 是 **API 21** 才有的，minSdk 还是 19 的时候
                //   这里必须判 `SDK_INT < LOLLIPOP` 退回无头版本，否则 4.4 上直接
                //   NoSuchMethodError —— 而带 Referer/UA 的 IPTV 源是常态，等于 100% 播不了。
                //   1.5 起 minSdk 提到 21，这个退化分支连同它的取舍一起删掉：
                //   现在所有设备都能带请求头，不再有「少个 Referer 就 403」的那批机器。
                if (s.headers.isEmpty()) {
                    video.setVideoURI(u);
                } else {
                    // 很多 IPTV 源不带 Referer/UA 就是 403。m3u 里解析出来的头在这里派上用场。
                    Map<String, String> h = new HashMap<>(s.headers);
                    video.setVideoURI(u, h);
                }
            video.start();          // VideoView 的约定：prepared 之前调用 start() → prepared 后自动开播
        } catch (Throwable t) {
            // ⚠️ 一定要带堆栈：只打 toString() 的话日志里就只有一行
            //    「java.lang.IllegalStateException」（没有 message），根本看不出是哪一步抛的。
            Log.w(TAG, "setVideoURI/start 失败", t);
            // 播放器对象已被这一次失败带坏，下一轮重试要换新的
            playerDead = true;
            failWith("地址无法交给播放器：" + t);
            return;
        }

        ui.postDelayed(prepareTimeout, PREPARE_TIMEOUT_MS);

        SourceStore.saveCurrentUrl(this, s.url);
        js("__yspUI&&__yspUI.setPlaying(" + JSONObject.quote(s.url) + ")");
    }

    /**
     * 把 VideoView 整个换成一个新的，逼 MediaPlayer 从零重建。
     *
     * ⚠️ 为什么光靠 stopPlayback() 不行（这是实测出来的，不是推测）：
     *    mediaserver 崩掉之后，VideoView.stopPlayback() 内部走的是
     *    `mMediaPlayer.reset(); mMediaPlayer.release(); mMediaPlayer = null;`
     *    —— 而 reset() 在「服务已死」的播放器上会抛 IllegalStateException。
     *    异常一抛，后面的 release() 和 mMediaPlayer = null 都不执行，
     *    VideoView 里就留下一个既不释放又不可用的 MediaPlayer。
     *    此后每次 setVideoURI() 都继续抛 IllegalStateException
     *    （实测连续 5 次全是这个错），重试因此永远不可能成功。
     *    换掉整个 View 是唯一不依赖 MediaPlayer 内部状态的解法。
     *
     * 层级：新的 VideoView 必须插回原来的位置（它是 SurfaceView，得在最底下，
     * 否则会盖住上面那层透明面板 WebView）。
     */
    private void rebuildVideo() {
        playerDead = false;

        ViewGroup parent = (ViewGroup) video.getParent();
        int idx = (parent == null) ? 0 : parent.indexOfChild(video);

        try { video.stopPlayback(); } catch (Throwable ignored) {}
        try { video.suspend(); } catch (Throwable ignored) {}   // 主动放掉 Surface，别让坏对象握着
        if (parent != null) parent.removeView(video);

        VideoView nv = new VideoView(this);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
        lp.gravity = Gravity.CENTER;
        nv.setLayoutParams(lp);
        nv.setId(R.id.video);

        video = nv;
        if (parent != null) parent.addView(nv, Math.max(0, idx));
        setupVideo();          // 监听器是绑在实例上的，新实例要重新绑

        Log.i(TAG, "播放器已重建（旧的 MediaPlayer 已不可用）");
    }

    private void retry() {
        if (current == null) { openManage(); return; }
        play(current, true);
    }

    /**
     * 失败收口。所有「这一条播不出来」的路径最后都会走到这里
     * （onError / 起播看门狗 / setVideoURI 抛异常）。
     *
     * ======================================================================
     * v1.4 起这里多做一件事：先看【同一个台还有没有别的地址】
     * ======================================================================
     * 真实聚合清单里约 1/3 是死链（162 条有镜像的地址里 35 条不通，实测），
     * 而同一个台常有 2~8 路地址。以前每一路都要用户自己往下换一条 ——
     * 一个台全不通就得手动试五六次，每次还都要干等看门狗。
     * 现在自己往下走，走到上限或没得走了才报失败。
     *
     * ⚠️ 【只有本方法会顺延】。onCompletion（点播播完）不走这里 ——
     *    那是正常播完，不是失败。把它当失败会导致「看完一集自动去试别的台」。
     *
     * ⚠️ 用户打开源管理浮层时不顺延：那是「我要接管」的信号，
     *    在浮层背后继续偷偷换台只会让人莫名其妙。
     */
    private void failWith(String why) {
        final Source failed = current;

        if (failed != null) {
            sessionBad.add(failed.url);
            // 每一路失败都要推给页面：列表里那一条会变暗并打上 ⚠。
            // 用户回头扫一眼就知道哪些地址是死的（也是下一轮顺延的排序依据）。
            js("__yspUI&&__yspUI.playFailed(" + JSONObject.quote(failed.url) + ")");
        }

        Source nx = null;
        if (failed != null) {
            if (manageOpen) {
                // ⚠️ 一定要留日志。这条规则挡掉顺延时如果一声不吭，
                //    现场排障会得到「顺延没实现」这个完全错误的结论
                //    ——（第一次跑设备端用例就是这么被骗的：上一节结束时浮层没关，
                //      整节顺延全被挡掉，看起来像是功能没写）。
                log("源管理浮层开着，跳过镜像顺延（用户正在接管，不在他背后换台）");
            } else {
                // ⚠️ 预算从这里起算，而且只在**这一串的第一次失败**时起算。
                //    写在这里（而不是 onPrepared）才能覆盖「播了十分钟才断」——
                //    那是 IPTV 最常见的失败方式。
                if (!mirroring) {
                    mirroring = true;
                    mirrorWalkStart = System.currentTimeMillis();
                }
                boolean withinCount = mirrorTried.size() < Mirrors.MAX_ATTEMPTS;
                boolean withinTime = (System.currentTimeMillis() - mirrorWalkStart) < Mirrors.WALK_BUDGET_MS;
                if (withinCount && withinTime) {
                    nx = Mirrors.next(sources, failed, mirrorTried, sessionBad);
                } else if (!withinCount) {
                    log("镜像顺延已达上限（" + Mirrors.MAX_ATTEMPTS + " 路），不再往下试");
                } else {
                    log("镜像顺延已超时（" + Mirrors.WALK_BUDGET_MS + "ms），不再往下试");
                }
            }
        }

        if (nx != null) {
            final Source go = nx;
            final long gen = playGen;
            final int nth = mirrorTried.size() + 1;
            final int cap = Math.min(mirrorTotal, Mirrors.MAX_ATTEMPTS);
            playFailed = false;   // 还在自己往下走，别让确认键在这儿变成「重试」
            showStatus("这个台的第 " + nth + "/" + cap + " 路地址…",
                    failed.display() + "\n" + Source.shortUrl(failed.url) + "\n\n" + why
                    + "\n\n这一路不通，自动换同一个台的下一路"
                    + "\n（按「菜单」键可以直接换别的台）");
            log("镜像顺延 " + nth + "/" + cap + "：" + Source.shortUrl(failed.url)
                    + " → " + Source.shortUrl(go.url));
            // ⚠️ 不能在这里直接 play()：failWith 可能是从 MediaPlayer 的 onError
            //    回调里进来的，在回调里立刻 stopPlayback + setVideoURI 是重入。
            //    顺延 250ms 出去，并核对世代号与当前源 —— 期间用户要是自己换了台，
            //    这个延迟任务必须作废，否则会把用户刚选的台又拽回来。
            ui.postDelayed(new Runnable() {
                @Override public void run() {
                    if (playGen != gen || current != failed) return;
                    nextPlayIsHop = true;   // 让 play() 别拿「正在连接…」盖掉上面那段说明
                    play(go, false);
                }
            }, 250);
            return;
        }

        // ---- 没有可试的了（或用户接管了），正式报失败 ----
        playFailed = true;
        started = false;
        String name = (failed == null) ? "" : failed.display();
        String url = (failed == null) ? "" : Source.shortUrl(failed.url);
        String mirrorNote = (mirrorTotal > 1)
                ? "\n\n这个台一共 " + mirrorTotal + " 路地址，已经试过 " + mirrorTried.size() + " 路，都不通。"
                  + "\n（下次它还会先挑没试过的那几路）"
                : "";
        showStatus("无法播放",
                name + "\n" + url + "\n\n" + why + mirrorNote
                + "\n\n按「确认」重试 · 按「菜单」换一条源");
        log("播放失败: " + name + " —— " + why
                + (mirrorTotal > 1 ? "（同台 " + mirrorTotal + " 路，本轮已试 "
                                     + mirrorTried.size() + " 路）" : ""));
    }

    // =====================================================================
    // 面板 WebView
    // =====================================================================

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupPanel() {
        WebSettings s = panelWeb.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // 页面本体是 file:///android_asset/custom.html，它要能引同目录的
        // inject.css / inject.js / custom.css / custom.js；assets 属于受限访问，
        // 另外两个（file→file 的 XHR、file→任意域）保持关闭。
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowContentAccess(false);
        s.setLoadsImagesAutomatically(true);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setDefaultTextEncodingName("UTF-8");
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);   // API 17 起可用，minSdk 21 已覆盖

        panelWeb.setBackgroundColor(0);        // ⚠️ 关键：全透明，不然会盖住底下的视频
        panelWeb.setHorizontalScrollBarEnabled(false);
        panelWeb.setVerticalScrollBarEnabled(false);
        panelWeb.setOverScrollMode(View.OVER_SCROLL_NEVER);
        panelWeb.setFocusable(false);
        panelWeb.setFocusableInTouchMode(false);

        // API 19 起可用，minSdk 21 已覆盖，不需要守卫
        boolean debuggable = (getApplicationInfo().flags
                & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        panelWeb.addJavascriptInterface(new UiBridge(), "yspCustom");

        panelWeb.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                return true;   // 本页不该发生任何导航，一律拦掉
            }

            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                Log.e(TAG, "面板页加载失败 " + code + " " + desc + " @ " + failingUrl);
                if (failingUrl != null && failingUrl.startsWith("file://")) {
                    showStatus("面板加载失败",
                            "找不到或读不了 assets/custom.html（" + desc + "）。\n"
                            + "这是打包问题，不是网络问题。");
                }
            }
        });

        panelWeb.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "[panel] " + m.message() + " @" + m.lineNumber());
                return true;
            }
        });
    }

    /** 面板脚本就绪：把源列表推过去，然后开播 */
    private void onPageReady() {
        pageReady = true;

        sources = SourceStore.load(this);

        pushSources();
        pushRemote();

        if (started) return;   // 页面重载时不打断正在播的那条

        // 一条源都没有（v1.9 起这就是默认状态：不再内置示例源）→ 直接把用户
        // 送到「源管理」，而不是让他对着一块黑屏/video 猜该按哪个键。
        //
        // ⚠️ 浮层是会关的：关掉之后没有源的面板连开都开不起来（inject.js 的
        //    openPanel() 见到 0 行直接返回 false），所以原生状态层必须**常驻**一条
        //    提示 —— 否则用户关掉浮层就只剩一块黑屏，没有任何回来的路。
        if (sources.isEmpty()) {
            pushPlaying("");
            showZeroHint();
            js("__yspUI&&__yspUI.toast('还没有源，从下面选一种方式添加')");
            openManage();
            return;
        }

        // 接着上次那条播；上次那条没了就播第一条
        String last = SourceStore.loadCurrentUrl(this);
        Source s = null;
        if (last != null && !last.isEmpty()) {
            for (Source t : sources) if (last.equals(t.url)) { s = t; break; }
        }
        if (s == null) s = sources.get(0);
        play(s, false);

        maybeShowHint();
    }

    /** 首次使用给一次操作提示（只给一次，别每次进来都烦人） */
    private void maybeShowHint() {
        try {
            android.content.SharedPreferences p =
                    getSharedPreferences(PREF_HINT, MODE_PRIVATE);
            if (p.getBoolean(K_HINT_SHOWN, false)) return;
            p.edit().putBoolean(K_HINT_SHOWN, true).apply();
        } catch (Throwable ignored) {}
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                js("__yspUI&&__yspUI.toast('确认键 选台　菜单键 管理源')");
            }
        }, 2500);
    }

    // =====================================================================
    // 源列表
    // =====================================================================

    private void reload() {
        sources = SourceStore.load(this);
        pushSources();
        // ⚠️ 这里必须也推一次「记住的清单地址」。会改到它的路径不止一条：
        //    · 从手机上（局域网页面）导入一份远程清单 → 地址变成那份清单的；
        //    · 电视上刷新远程清单 → 地址可能跟着重定向变；
        //    少了这一句，用户在手机导入完之后回到电视，菜单里那个「刷新远程清单」
        //    要等下次进这个页面才出现。（pushRemote 在页面侧是幂等的，重复推没代价。）
        pushRemote();
        // 正在播的那条可能已经被删了（例如从手机端清空）—— 保持播放，只是列表里不再有它
        if (current != null && findSource(current.url) == null) {
            pushPlaying(current.url);
        }
    }

    private void pushSources() {
        if (!pageReady) return;
        JSONArray arr = new JSONArray();
        try {
            for (Source s : sources) {
                JSONObject o = new JSONObject();
                o.put("n", s.name == null ? "" : s.name);
                o.put("g", s.group == null ? "" : s.group);
                o.put("u", s.url);
                if (!s.headers.isEmpty()) {
                    JSONObject h = new JSONObject();
                    for (Map.Entry<String, String> e : s.headers.entrySet()) {
                        h.put(e.getKey(), e.getValue());
                    }
                    o.put("h", h);
                }
                arr.put(o);
            }
        } catch (Throwable t) {
            Log.w(TAG, "构造源列表 JSON 失败", t);
        }
        js("__yspUI&&__yspUI.setSources(" + JSONObject.quote(arr.toString()) + ")");
    }

    private void pushPlaying(String url) {
        js("__yspUI&&__yspUI.setPlaying(" + JSONObject.quote(url == null ? "" : url) + ")");
    }

    /**
     * 把「记住的远程清单地址」推给页面。
     * 页面拿它决定菜单里出不出现「刷新远程清单」——没有清单地址时那一项根本不该出现，
     * 否则用户按下去只会得到一句「还没记住任何清单地址」。
     */
    private void pushRemote() {
        if (!pageReady) return;
        js("__yspUI&&__yspUI.setRemote("
           + JSONObject.quote(SourceStore.loadRemoteUrl(this)) + ")");
    }

    private Source findSource(String url) {
        if (url == null) return null;
        for (Source s : sources) if (s.sameAsUrl(url)) return s;
        return null;
    }

    // =====================================================================
    // 导入（会联网，必须在后台线程）
    // =====================================================================

    /** 一次导入任务：拿到一个 SourceImport 去干活，返回结果 */
    private interface ImportJob {
        SourceImport.Result run(SourceImport imp);
    }

    /**
     * 跑一次导入。
     *
     * ⚠️ 必须开线程。Android 3.0 起在主线程做网络 I/O 会直接抛
     *    NetworkOnMainThreadException —— 而「从网址导入」**一定**会联网，
     *    连屏上键盘加一条普通地址也要先抓一下（看它是一路流还是一份清单）。
     *    这一版之前 addOne 是纯解析，可以直接在 ui.post 里跑；现在不行了。
     * ⚠️ 结果要 ui.post 回主线程：reload() 会改 sources 字段、又会调
     *    evaluateJavascript，两边都不是线程安全的。
     *
     * @param toKeyboard true = 结果回给屏上键盘（addResult，失败时停在键盘上让用户改）
     *                   false = 只弹一句 toast（刷新清单走这条）
     */
    private void runImport(final String tag, final ImportJob job, final boolean toKeyboard) {
        new Thread(new Runnable() {
            @Override public void run() {
                SourceImport.Result r = null;
                try {
                    r = job.run(new SourceImport(CustomActivity.this));
                } catch (Throwable t) {
                    Log.w(TAG, tag + " 任务异常", t);
                }
                final SourceImport.Result fr = r;
                ui.post(new Runnable() {
                    @Override public void run() { onImportDone(tag, fr, toKeyboard); }
                });
            }
        }, "ysp-import").start();
    }

    /** 导入结果回到主线程之后：刷界面 + 回报 */
    private void onImportDone(String tag, SourceImport.Result r, boolean toKeyboard) {
        if (r == null) {
            String msg = "导入出错了（细节见 adb logcat -s YSPTV）";
            if (toKeyboard) js("__yspUI&&__yspUI.addResult(false," + JSONObject.quote(msg) + ")");
            else toastInPage(msg);
            return;
        }
        SourceImport.logResult(tag, r);
        reload();          // reload() 里会连「记住的清单地址」一起推给页面
        // v1.11：同步刷新/退订可能把「正在播的那条」删掉 → 自动换一台，
        // 不换的话播放器会一直抱着一条已经不存在的源（后面任何重载都失败）。
        if (r.playingRemoved) switchToFirstAvailable();
        if (toKeyboard) {
            js("__yspUI&&__yspUI.addResult(" + (r.ok ? "true" : "false")
               + "," + JSONObject.quote(r.msg) + ")");
        } else {
            toastInPage(r.msg);
        }
    }

    /**
     * 正在播的那条没了（同步刷新/退订把它删了）→ 换到列表里第一条还在的台。
     *
     * ⚠️ 必须在 {@link #reload()} 之后调用：reload() 才会把 sources 换成最新的，
     *    在那之前 sources 还是旧表，照着它找「第一条还在的」会挑到一个刚被删掉的地址。
     * 实在没有可播的了（退订之后列表清空）就只停播，不硬播。
     */
    private void switchToFirstAvailable() {
        try {
            if (sources.isEmpty()) {
                current = null;
                pushPlaying("");
                showStatus("没有可播的源", "按「菜单」键重新导入一份清单");
                return;
            }
            current = sources.get(0);
            play(current, false);
        } catch (Throwable t) {
            Log.w(TAG, "切换到第一条源失败", t);
        }
    }

    // =====================================================================
    // 局域网导入
    // =====================================================================

    /** 系统剪贴板里的文本；没有/读不到一律当空串（调用方只需判空） */
    private String readClipboard() {
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            android.content.ClipData cd = cm.getPrimaryClip();
            if (cd == null || cd.getItemCount() == 0) return "";
            CharSequence cs = cd.getItemAt(0).coerceToText(this);
            return cs == null ? "" : cs.toString();
        } catch (Throwable t) {
            // Android 10+ 只允许前台应用读剪贴板。理论上这一页在前台时读得到，
            // 但厂商 ROM/多用户环境都可能拒绝 —— 读不到不是错误路径，给个空串即可。
            Log.w(TAG, "读剪贴板失败", t);
            return "";
        }
    }

    private void startLan() {
        if (lan == null) {
            lan = new LanImportServer(this, new LanImportServer.Listener() {
                @Override public void onSourcesChanged() {
                    ui.post(new Runnable() {
                        @Override public void run() {
                            int before = sources.size();
                            reload();
                            int delta = sources.size() - before;
                            if (delta > 0) toastInPage("从局域网导入了 " + delta + " 条源");
                            else if (delta < 0) toastInPage("从局域网删除了 " + (-delta) + " 条源");
                        }
                    });
                }
            });
        }
        if (lan.isRunning()) { pushLan(); return; }
        if (lanStarting) return;
        lanStarting = true;
        new Thread(new Runnable() {
            @Override public void run() {
                // ServerSocket.bind + 枚举网卡，别占主线程
                final String err = lan.start();
                ui.post(new Runnable() {
                    @Override public void run() {
                        lanStarting = false;
                        lanErr = (err == null) ? "" : err;
                        if (err != null) Log.w(TAG, "局域网服务未启动：" + err);
                        pushLan();
                    }
                });
            }
        }, "ysp-lan-start").start();
    }

    private void stopLan() {
        LanImportServer s = lan;
        if (s != null && s.isRunning()) {
            new Thread(new Runnable() {
                @Override public void run() {
                    try { s.stop(); } catch (Throwable ignored) {}
                }
            }, "ysp-lan-stop").start();
        }
        lanErr = "";
    }

    private void pushLan() {
        boolean ok = (lan != null && lan.isRunning());
        String text = ok ? lan.addressText() : "";
        String err = ok ? "" : (lanErr.isEmpty() ? "还没起来" : lanErr);
        js("__yspUI&&__yspUI.setLan(" + JSONObject.quote(text) + ","
           + JSONObject.quote(err) + ")");
    }

    // =====================================================================
    // 状态层 / 工具
    // =====================================================================

    private void showStatus(final String title, final String msg) {
        zeroHint = null;                     // 换成别的状态了，零源提示不再适用
        ui.post(new Runnable() {
            @Override public void run() {
                if (status == null) return;
                status.setVisibility(View.VISIBLE);
                statusTitle.setText(title);
                statusMsg.setText(msg == null ? "" : msg);
            }
        });
    }

    private void hideStatus() {
        zeroHint = null;
        ui.post(new Runnable() {
            @Override public void run() {
                if (status != null) status.setVisibility(View.GONE);
            }
        });
    }

    /**
     * 零源常驻提示（v1.9）。
     *
     * ⚠️ 为什么必须是【常驻】而不是导入前show 一次：零源时选台面板连开都开不起来
     *    （inject.js 的 openPanel() 见到 0 行直接返回 false），浮层又是可以关掉的。
     *    提示要是跟着浮层一起没了，用户就只剩一块黑屏，没有任何回来的路。
     *
     * ⚠️ 但它和浮层【不能同时可见】—— 实机截图里两者是同一块区域，
     *    文字直接叠在一起（浮层在左半屏，状态层居中，正好压住菜单右侧的 tail 文案）。
     *    所以这里把文案记下来，由 {@link #applyZeroHintVisibility} 按浮层开关决定显不显示。
     */
    private void showZeroHint() {
        zeroHint = new String[] {
            "还没有源",
            "按【确认键】或「菜单」键打开源管理\n"
            + "· 局域网导入：手机上打开屏幕上的网址\n"
            + "· 从剪贴板导入：复制一段地址或清单\n"
            + "· 屏上输入新源：用遥控器打字"
        };
        applyZeroHintVisibility();
    }

    /** 浮层开着 → 藏；关着且仍零源 → 露出来（这是用户唯一的「怎么加源」指引） */
    private void applyZeroHintVisibility() {
        final String[] h = zeroHint;
        if (h == null) return;
        ui.post(new Runnable() {
            @Override public void run() {
                if (status == null) return;
                boolean show = !manageOpen;
                status.setVisibility(show ? View.VISIBLE : View.GONE);
                if (show) {
                    statusTitle.setText(h[0]);
                    statusMsg.setText(h[1]);
                }
            }
        });
    }

    private void toastInPage(final String text) {
        js("__yspUI&&__yspUI.toast(" + JSONObject.quote(text) + ")");
    }

    private void openManage() {
        js("__yspUI&&__yspUI.openManage()");
    }

    private void toggleManage() {
        if (manageOpen) js("__yspUI&&__yspUI.closeManage()");
        else openManage();
    }

    private void key(String name) {
        js("__yspUI&&__yspUI.key('" + name + "')");
    }

    private void js(final String code) {
        if (panelWeb == null) return;
        ui.post(new Runnable() {
            @Override public void run() {
                try { panelWeb.evaluateJavascript(code, null); }
                catch (Throwable t) { Log.w(TAG, "js err: " + code, t); }
            }
        });
    }

    // =====================================================================
    // 遥控器
    // =====================================================================

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int code = e.getKeyCode();
        if (e.getAction() != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(e);

        // ---- 播放失败时，确认键 = 重试（比先弹面板再选一次顺得多）----
        //
        // ⚠️ 必须加 !manageOpen：源管理浮层开着的时候，按键归浮层所有。
        //    少了这一个条件，一条点播流播完（onCompletion 也会把 playFailed 置真）
        //    或者某条源加载失败之后，用户按「菜单」打开源管理，会发现确认键
        //    整个失灵 —— 每一次确认都被这里截走去重试播放，永远到不了页面。
        //    实测：6 项键盘用例全挂，根因就是这一处。
        if (playFailed
                && !manageOpen
                && (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                    || code == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
            if (e.getRepeatCount() == 0) retry();
            return true;
        }

        switch (code) {
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_INFO:
                if (e.getRepeatCount() == 0) toggleManage();
                return true;

            case KeyEvent.KEYCODE_PROG_BLUE:
                if (e.getRepeatCount() == 0) openManage();
                return true;

            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                key("UP");
                return true;

            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                key("DOWN");
                return true;

            case KeyEvent.KEYCODE_DPAD_LEFT:
                key("LEFT");
                return true;

            case KeyEvent.KEYCODE_DPAD_RIGHT:
                key("RIGHT");
                return true;

            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                // 一条源都没有的时候，面板根本打不开 —— 直接把用户送到「源管理」
                if (sources.isEmpty() && !manageOpen) {
                    if (e.getRepeatCount() == 0) openManage();
                    return true;
                }
                if (e.getRepeatCount() == 0) key("OK");
                return true;

            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE: {
                boolean wantPause = (code == KeyEvent.KEYCODE_MEDIA_PAUSE)
                        || (code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE && video.isPlaying());
                try {
                    if (wantPause) video.pause();
                    else { video.start(); hideStatus(); }
                } catch (Throwable t) {
                    Log.w(TAG, "播放/暂停失败", t);
                }
                return true;
            }

            case KeyEvent.KEYCODE_BACK:
                // 有没有浮层要关，由页面说了算（它知道当前在菜单/键盘/删除/面板哪一层）；
                // 它关完了会回调 yspCustom.back()，才轮到这里的「连按两次退出」。
                key("BACK");
                return true;

            default:
                break;
        }
        return super.dispatchKeyEvent(e);
    }
}
