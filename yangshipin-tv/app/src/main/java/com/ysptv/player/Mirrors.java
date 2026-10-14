package com.ysptv.player;

import java.text.Normalizer;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 「同一个台的多路镜像」—— 台名归一化 + 选下一路。
 *
 * ==========================================================================
 * 一、为什么必须归一化，不能直接比台名
 * ==========================================================================
 * 真实聚合清单（best-fan/iptv-sources 的 cn_all.m3u8，181 条）里，
 * 明明是【同一个台】，写法却五花八门：
 *     CCTV1 (×2) / CCTV-1 (×3) / CCTV-1 (720p) (×1)
 *     CCTV6 / CCTV-6 / CCTV-6 (1080p)      CCTV9 / CCTV-9
 *     CCTV14 / CCTV-14                     CCTV17 / CCTV-17 (1080p)
 * 在这份清单上量过（tools/ 里那次统计的原始数字）：
 *     严格同名   → 84 个台，其中 47 个有镜像，覆盖 144 条（79.6%）
 *     本类归一化 → 62 个台，其中 43 个有镜像，覆盖 162 条（89.5%）
 * 也就是白捡 10 个百分点。少归一化这一步，功能就只能做一半。
 *
 * 归一化规则（顺序即执行顺序，改顺序结果会变）：
 *   ① NFKC —— 全角转半角（＋→+、（）→()、［］→[]）
 *   ② 转小写 —— ⚠️ 必须显式给 Locale.ROOT。用默认 locale 的话，
 *      土耳其语环境里 "I".toLowerCase() 得到的是 "ı"（无点 i），
 *      CCTV 系列会全部对不上。这不是理论问题，是 JDK 有文档的行为。
 *   ③ 抹掉分隔符：空白 - _ · ． . 、 , ， : ： | / \ ~
 *   ④ 剥掉尾部的画质标签（最多剥 3 轮）：(720p) (1080p) HD 高清 标清 超清 蓝光 流畅 …
 *
 * ⚠️ 第 ③ 步【必须保留 + 和 &】：CCTV5 和 CCTV5+ 是两个不同的台。
 *    真实清单里 CCTV5 有 4 路、CCTV5+ 单独有 4 路 —— 顺手把 + 抹掉的话，
 *    两个台会被并成一个，选路时会把用户从「体育频道」拽到「体育赛事频道」。
 *    所以分隔符表是白名单式的一颗颗列出来的，不是「非字母数字全抹」。
 *
 * ==========================================================================
 * 二、⚠️ 没有台名的源【不参与】镜像分组
 * ==========================================================================
 * 用户直接粘一个地址进来（屏上键盘的「地址」栏、局域网页面填网址）时，
 * Source.name 是 null，列表里显示的是从 URL 截出来的兜底名。
 * 这种源如果也参与分组，「所有没名字的源」会因 key 都是 "" 而被当成同一个台，
 * 选路时就把互不相干的地址当成了彼此的镜像 —— 这是本功能可能犯的最坏的错
 * （用户点 A 却播出了 B）。所以：
 *     key() 对空/无名字一律返回 ""，而 count()/next() 见到 "" 直接放弃。
 * iptv_realworld_test 里有一条断言专门钉这个行为（那条人为死链就是匿名源）。
 *
 * ==========================================================================
 * 三、⚠️ 本类【刻意】不使用任何 Android API
 * ==========================================================================
 * 和 Source / M3uParser / PlaylistFetcher 一样，本类要能在宿主 JVM 上
 * 直接 javac + 跑单测（tools/hosttest/MirrorsTest.java），不用开模拟器。
 * 往这里加一行 android.util.Log 就会让 tools/custom_source_test.mjs 的
 * 「Source/M3uParser/PlaylistFetcher 都不依赖 Android」那条断言变红 ——
 * 那是设计，不是意外。
 */
final class Mirrors {

    private Mirrors() {}   // 纯静态工具类

    // =====================================================================
    // 策略常量
    //
    // 放在这里而不是 CustomActivity：镜像顺延的全部策略应当只有一个出处在，
    // 改参数不用两头找。
    // =====================================================================

    /**
     * 一轮自动顺延最多试几路（含用户自己点的那一路）。
     *
     * 定成 4 的依据是实测的耗时，不是拍脑袋：
     *   · 死链的主流失败方式是「连接被黑洞吞掉后干等」—— 162 个地址实测
     *     p50 = 5002ms、p90 = 5003ms（UND_ERR_SOCKET），不是秒失败；
     *     另外 5 条 404、1 条证书过期是秒失败。
     *   · 活链取到清单 p50 = 108ms、p90 = 619ms、max = 2698ms。
     * 按典型 5 秒失败算，4 路的最坏等待 ≈ 20 秒；全撞上 15 秒看门狗才到 45 秒。
     * 真实清单里 62 个台有 43 个是多路的，其中 2~4 路的占绝大多数 ——
     * 4 路足够把「点进去是黑的」消掉大半，再加就不划算（用户已经在等了）。
     */
    static final int MAX_ATTEMPTS = 4;

    /**
     * 整轮自动顺延的总时长上限。
     *
     * 有 MAX_ATTEMPTS 为什么还要这个：每一路都可能刚好撞上 15 秒起播看门狗，
     * 4 路就是 60 秒。这条预算把最坏情况拉回到可解释的范围里 ——
     * 用户看到的是「转到第 3 路时停手了」，而不是一段说不清多久的黑屏。
     */
    static final long WALK_BUDGET_MS = 40000L;

    // =====================================================================
    // 归一化
    // =====================================================================

    /**
     * 尾部的画质标签。最多剥 3 轮（"CCTV-1 1080p HD" 这种要剥两层）。
     * 括号可有可无、全角半角都认 —— NFKC 会把全角括号转成半角，
     * 但 【】 不在 NFKC 的兼容映射里，所以两组括号都要列。
     */
    private static final Pattern QUALITY = Pattern.compile(
            "(?i)(?:\\s*[\\(\\[（【]?\\s*"
            + "(?:1080p|720p|576p|480p|360p|4k|8k|uhd|fhd|hd|sd|超清|高清|标清|蓝光|流畅)"
            + "\\s*[\\)\\]）】]?\\s*)$");

    /**
     * 分隔符。⚠️ 白名单式列举：+ 和 & 不在里面，见类注释。
     *
     * 末尾那四个是【不可见字符】：零宽空格、零宽非连接符、零宽连接符、BOM。
     * 从网页/聊天窗口复制台名时经常捎带进来，肉眼完全看不出来，
     * 而它们既不是 isWhitespace 也不是 isSpaceChar —— 只靠空白判断漏得掉。
     */
    private static final String SEPARATORS =
            "-_·．.、,，:：|/\\~～\u3000\u200b\u200c\u200d\ufeff";

    /**
     * 台名 → 归一化 key。空名字（含 null / 纯分隔符 / 剥完只剩空）返回 ""。
     * 返回 "" 意味着「这个源不参与镜像分组」。
     */
    static String key(Source s) {
        if (s == null) return "";
        return normalize(s.name);
    }

    /** 归一化的裸实现（单测直接打这个，便于逐条规则验证） */
    static String normalize(String name) {
        if (name == null) return "";
        String s = Normalizer.normalize(name, Normalizer.Form.NFKC);
        s = s.toLowerCase(Locale.ROOT);

        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            // ⚠️ isWhitespace 对 U+00A0 这类返回 false（NBSP 是被 NFKC 先转成普通空格
            //    才漏不到，但 U+2000 段里还有别的空间字符），所以两个判断都要留着；
            //    真正靠得住的其实是上面那张 SEPARATORS 白名单。
            if (Character.isWhitespace(c) || Character.isSpaceChar(c)) continue;
            if (SEPARATORS.indexOf(c) >= 0) continue;
            sb.append(c);
        }
        s = sb.toString();

        for (int i = 0; i < 3; i++) {
            String t = QUALITY.matcher(s).replaceAll("");
            if (t.equals(s)) break;
            s = t;
        }
        return s;
    }

    // =====================================================================
    // 选路
    // =====================================================================

    /**
     * 这个台一共有几路地址（含它自己）。无台名 → 1（也就是「没有镜像」）。
     * 给界面提示用（「这个台一共有 4 路地址」）。
     */
    static int count(List<Source> all, Source s) {
        String k = key(s);
        if (k.isEmpty() || all == null) return 1;
        int n = 0;
        for (int i = 0; i < all.size(); i++) {
            Source x = all.get(i);
            if (x != null && k.equals(key(x))) n++;
        }
        return Math.max(1, n);
    }

    /**
     * 挑下一路地址。
     *
     * 优先级（同优先级按清单里的原始顺序）：
     *   ① 同台、没试过、本次会话里也没失败过
     *   ② 都失败过时，退而求其次挑一条失败过的 —— 失败可能是网络抖动，
     *      不能因为「上次没通」就永远不再给机会；时间预算兜着最坏情况。
     * 返回 null = 没有可试的了，调用方该正式报失败。
     *
     * @param all      全量源
     * @param cur      刚失败的那一路
     * @param tried    本轮已经试过的地址（含 cur）；null 视作空
     * @param knownBad 本次会话里失败过的地址；null 视作空
     */
    static Source next(List<Source> all, Source cur, Set<String> tried, Set<String> knownBad) {
        if (all == null || cur == null) return null;
        String k = key(cur);
        if (k.isEmpty()) return null;        // ⚠️ 无台名 → 不做镜像假设，见类注释二

        Source fallback = null;
        for (int i = 0; i < all.size(); i++) {
            Source x = all.get(i);
            if (x == null || x.url == null || x.url.isEmpty()) continue;
            if (x.url.equals(cur.url)) continue;              // 它自己
            if (tried != null && tried.contains(x.url)) continue;
            if (!k.equals(key(x))) continue;                  // 不是同一个台
            if (knownBad != null && knownBad.contains(x.url)) {
                if (fallback == null) fallback = x;           // 垫底候选，先记着
                continue;
            }
            return x;                                         // ① 类，直接就用它
        }
        return fallback;                                      // ② 类，可能是 null
    }
}
