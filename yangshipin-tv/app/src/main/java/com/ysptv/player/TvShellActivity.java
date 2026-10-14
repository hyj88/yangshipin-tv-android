package com.ysptv.player;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.WindowManager;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * 电视端 Activity 的公共外壳：横屏策略 + 全屏沉浸 + 设备判定 + 资源读取。
 *
 * 抽出来是因为加了第二个 Activity（自定义源播放器）之后，这些东西要一模一样：
 *   · 「电视硬锁 LANDSCAPE / 手机 SENSOR_LANDSCAPE」的取舍
 *   · 全屏沉浸要对 API 30 和 5.0~10（API 21~29）两条路
 *   · 「是不是电视」的判定顺序（leanback 优先，不能拿触摸屏当主判据）
 * 复制一遍迟早会漂移，所以提成基类。
 *
 * ⚠️ 本类里【不允许】出现 API 28+ 的类型。要用的都放 Api28/Api30。
 *    理由（类加载期解析签名，`if (SDK_INT >= X)` 挡不住）见 Api28 的类注释。
 *    minSdk 21 之后 API 21 的类型可以直接用了（Api21 已在 1.5 删除），
 *    但 API 28/30 的隔离照旧 —— 隔离线跟着 minSdk 走，最低那批设备还是 5.0/5.1。
 */
public abstract class TvShellActivity extends Activity {

    protected static final String TAG = "YSPTV";

    /** 「横屏策略」那条日志只报一次（onCreate / onResume 都会走到 applyOrientation） */
    private boolean orientationLogged = false;

    /** 应用名带时间戳的日志前缀，方便 adb logcat -s 过滤 */
    protected void log(String msg) {
        Log.i(TAG, msg);
    }

    // =====================================================================
    // 生命周期
    // =====================================================================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 刘海屏铺满 + 内容延伸到系统栏背后（分别要 API 28 / API 30 的类型，必须隔离）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Api28.fullBleed(getWindow());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Api30.edgeToEdge(getWindow());

        applyOrientation();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyOrientation();
        hideSystemUi();
    }

    /** 弹窗/输入法/切到别的 App 再回来，系统栏会冒出来 —— 重新获得焦点时再收一次 */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    // =====================================================================
    // 全屏 + 横屏
    // =====================================================================

    /**
     * 全屏沉浸：隐藏状态栏 + 导航栏。
     *
     * API 30 起用 WindowInsetsController —— 老的 setSystemUiVisibility 已废弃，
     * 且在新系统上会被忽略。5.0~10（API 21~29）走老 flag：
     * SYSTEM_UI_FLAG_IMMERSIVE_STICKY 从 API 19 起可用，minSdk 21 已覆盖，不需要守卫。
     */
    protected void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Api30.hideBars(getWindow())) return;
        View d = getWindow().getDecorView();
        // noinspection deprecation
        d.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    /**
     * 自动横屏。
     *
     * 电视和手机要的其实不是同一种「横屏」：
     *  · 电视：部分盒子带重力感应，方向抖动会让画面莫名翻转 → 硬锁 LANDSCAPE。
     *  · 手机：必须横屏，但允许调头握持时跟着转 → SENSOR_LANDSCAPE（只在左右横屏间二选一）。
     *
     * ⚠️ 别用 FULL_SENSOR / SENSOR / USER 系列。那些会尊重系统的「自动旋转」开关，
     *    用户把旋转锁成竖屏后 App 就真的竖起来了 —— 这正是「打开就横屏」要避免的。
     */
    protected void applyOrientation() {
        boolean tv = isTv();
        int want = tv
                ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;

        // ⚠️ 这条日志要报告的是「判定结果」，所以必须放在下面那个 early-return【之前】。
        //    manifest 里给两个 Activity 都写了保底的 screenOrientation="landscape"，
        //    于是在电视上 getRequestedOrientation() 恰好就等于 want，
        //    一旦把日志写在 setRequestedOrientation 旁边，它就永远不会打出来。
        //    （这正是回归测试 device_test 第 13.3 项 / phone_orientation_test 报的那一项。）
        if (!orientationLogged) {
            orientationLogged = true;
            Log.i(TAG, "横屏策略: " + (tv
                    ? "电视→LANDSCAPE（硬锁，不跟随重力感应）"
                    : "手机→SENSOR_LANDSCAPE（只在左右横屏之间切换）"));
        }

        if (getRequestedOrientation() == want) return;   // manifest 保底值已经对了，不必再设
        try {
            setRequestedOrientation(want);
        } catch (Throwable t) {
            Log.w(TAG, "setRequestedOrientation(" + want + ") 失败", t);
        }
    }

    /**
     * 判定是不是电视 / 大屏。
     * 1) 声明了 leanback 或 television 特性 —— 最权威，Android TV 认证设备必有；
     * 2) 完全没有触摸类输入 —— 电视棒/盒子的常见形态；
     * 3) 最小宽度 ≥600dp —— 兜底。
     *
     * ⚠️ 别把「没有触摸屏」当成主判据。实测 TV 模拟器同时声明了
     *    touchscreen / faketouch / multitouch 全家桶，反倒是不少真手机不声明
     *    baseline 的 touchscreen。所以这条只能排在 leanback 之后当补充。
     */
    protected boolean isTv() {
        if (hasFeature("android.software.leanback")
                || hasFeature("android.hardware.type.television")) {
            return true;
        }
        if (!hasTouchInput()) return true;
        return getResources().getConfiguration().smallestScreenWidthDp >= 600;
    }

    protected boolean hasTouchInput() {
        return hasFeature("android.hardware.touchscreen")
                || hasFeature("android.hardware.touchscreen.multitouch")
                || hasFeature("android.hardware.faketouch");
    }

    protected boolean hasFeature(String feature) {
        try {
            return getPackageManager().hasSystemFeature(feature);
        } catch (Throwable t) {
            return false;
        }
    }

    // =====================================================================
    // 工具
    // =====================================================================

    protected String readAsset(String name) {
        try {
            InputStream is = getAssets().open(name);
            BufferedReader br = new BufferedReader(
                    new InputStreamReader(is, StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
            br.close();
            return sb.toString();
        } catch (Exception e) {
            Log.e(TAG, "读取 assets/" + name + " 失败", e);
            return "";
        }
    }

    /* realEngineVersion() 已于 1.6 删除。
       它只被 MainActivity 那页「内核能力体检」用来在提示里写「内核 Chrome/xx」，
       而那页提示本身已经随 minSdk 24 一起删掉了（7.0 以下装不上，不需要解释为什么黑屏）。
       ⚠️ 它的方法值得一提，别一起忘掉：**不能**用页面里的 navigator.userAgent 取内核版本 ——
       央视频页面上我们设了伪装用的桌面 UA，页面里读到的就是那个假版本
       （实测踩过：明明是 Chromium 30，读出来却是「Chrome/120」）。
       要取真版本只能用 WebSettings.getDefaultUserAgent()（静态方法，与实例的
       setUserAgentString 无关）。真要再查内核，用 tools/browser_capability_probe.mjs。 */
}
