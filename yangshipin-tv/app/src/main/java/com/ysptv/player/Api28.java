package com.ysptv.player;

import android.os.Build;
import android.view.Window;
import android.view.WindowManager;

/**
 * API 28+ 才有的东西（刘海屏铺满）。
 *
 * ⚠️ 为什么要单独成类（这条规矩 minSdk 提到 **24** 之后【依然成立】，别以为可以合并回去）：
 *
 *   Dalvik/ART 在**类加载与校验**阶段就会解析方法体里引用的类型，而不是等到那行代码
 *   真跑起来才找。所以「Api28.fullBleed() 里写着 WindowManager.LayoutParams
 *   .LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES」这件事，只要出现在 TvShellActivity
 *   的方法体里，那么一台 5.1（API 22）的设备在**加载 TvShellActivity** 时就会
 *   NoClassDefFoundError —— 哪怕那段代码被 `if (SDK_INT >= P)` 包着。
 *   `if (SDK_INT >= X)` 守卫只挡「执行」，挡不住「解析」。
 *   拆成独立类后，只有系统版本真的够、真的调用到时才会去加载它。
 *
 *   隔离线跟着 **minSdk** 走，不跟着 compileSdk 走：
 *     · minSdk 19 时：API 21 / 28 / 30 都要隔离 → 曾有 Api21 / Api28 / Api30 三个类
 *     · minSdk 21 时：API 21 的类型可以直接用（Api21 已删），
 *                    但 **API 28 / 30 仍然必须隔离** —— 最低那批设备还是 5.0/5.1
 *     · minSdk 24 时（现在）：**本类依然不能删**。24 < 28 < 30，
 *                    一台 7.0（API 24）的设备加载含 API 30 类型的类，照样是
 *                    NoClassDefFoundError。别说「都 7.0 了还隔什么离」。
 */
@android.annotation.TargetApi(Build.VERSION_CODES.P)
final class Api28 {
    private Api28() {}

    static void fullBleed(Window w) {
        w.getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
    }
}
