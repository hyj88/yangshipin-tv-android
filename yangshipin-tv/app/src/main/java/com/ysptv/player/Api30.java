package com.ysptv.player;

import android.os.Build;
import android.view.Window;

/** API 30+ 的现代全屏 API。为什么必须单独成类，见 {@link Api28} 的类注释。 */
@android.annotation.TargetApi(Build.VERSION_CODES.R)
final class Api30 {
    private Api30() {}

    /** 内容延伸到系统栏背后 */
    static void edgeToEdge(Window w) {
        w.setDecorFitsSystemWindows(false);
    }

    /**
     * 隐藏系统栏。BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE：从屏幕边缘划一下能临时唤出
     * 系统栏，几秒后自动再隐藏 —— 比强行 HIDE 更贴合系统预期，也不会让手势导航失效。
     * 返回 false 表示拿不到 controller，调用方走老 flag。
     */
    static boolean hideBars(Window w) {
        // 故意写全限定名、不用 import：保持「API 30 的字样只出现在本文件里」这条规矩
        android.view.WindowInsetsController c = w.getDecorView().getWindowInsetsController();
        if (c == null) return false;
        c.hide(android.view.WindowInsets.Type.systemBars());
        c.setSystemBarsBehavior(
                android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        return true;
    }
}
