package com.ysptv.player;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Mirrors（镜像归一化 + 选路）的宿主 JVM 单测。不需要 Android、不需要模拟器。
 *
 * 用法（由 tools/custom_source_test.mjs 调起，也可手工跑）：
 *   javac -d /tmp/ysp-m3utest -encoding UTF-8 tools/hosttest/MirrorsTest.java \
 *         yangshipin-tv/app/src/main/java/com/hyj/ysptv/{Source,Mirrors}.java
 *   java -Dfile.encoding=UTF-8 -cp /tmp/ysp-m3utest com.ysptv.player.MirrorsTest
 *
 * 退出码 0 = 全过；非 0 = 有失败（并打印详情）。
 *
 * 这些用例里最要紧的不是「能合上」，而是【不能合错】：
 * 归一化合错了，用户点 A 会播出 B —— 那比「不做镜像顺延」糟得多。
 */
public final class MirrorsTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        t01_basicCctvVariants();
        t02_plusIsNotASeparator();
        t03_fullwidthAndCase();
        t04_qualityTags();
        t05_separatorsAndSpace();
        t06_nbsp();
        t07_doNotOvermerge();
        t08_emptyNameNoGrouping();
        t09_chineseQualityTag();
        t10_idempotent();
        t11_count();
        t12_nextInPlaylistOrder();
        t13_nextSkipsTried();
        t14_nextPrefersFreshOverBad();
        t15_nextExhausted();
        t16_nextLastResortBad();
        t17_nextEmptyKeyGivesUp();
        t18_realPlaylistShape();
        t19_policyConstants();
        t20_nextIgnoresOtherChannels();

        System.out.println();
        System.out.println("MirrorsTest: " + pass + " 过 / " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }

    // =====================================================================
    // 断言小工具（与 M3uParserTest 保持一致）
    // =====================================================================

    private static void ok(boolean cond, String what) {
        if (cond) { pass++; return; }
        fail++;
        System.out.println("  ✗ " + what);
    }

    private static void eq(Object got, Object want, String what) {
        boolean same = (got == null) ? want == null : got.equals(want);
        if (same) { pass++; return; }
        fail++;
        System.out.println("  ✗ " + what + "  期望[" + want + "] 实际[" + got + "]");
    }

    private static void section(String s) {
        System.out.println("· " + s);
    }

    private static Source src(String name, String url) {
        return new Source(name, url, "测试");
    }

    private static Source src(String name, String url, String group) {
        return new Source(name, url, group);
    }

    private static List<Source> list(Source... xs) {
        return new ArrayList<>(Arrays.asList(xs));
    }

    private static Set<String> set(String... xs) {
        return new LinkedHashSet<>(Arrays.asList(xs));
    }

    // =====================================================================
    // 归一化
    // =====================================================================

    private static void t01_basicCctvVariants() {
        section("01 CCTV 的三种写法必须归一到一个 key");
        // 真实清单里就是这么写的：CCTV1 ×2、CCTV-1 ×3、CCTV-1 (720p) ×1
        eq(Mirrors.normalize("CCTV1"), "cctv1", "CCTV1");
        eq(Mirrors.normalize("CCTV-1"), "cctv1", "CCTV-1");
        eq(Mirrors.normalize("CCTV-1 (720p)"), "cctv1", "CCTV-1 (720p)");
        eq(Mirrors.normalize("cctv 1"), "cctv1", "cctv 1（小写 + 空格）");
        eq(Mirrors.normalize("CCTV-1 综合"), "cctv1综合", "带频道后缀的【不该】并进来（保守）");
    }

    private static void t02_plusIsNotASeparator() {
        section("02 ⚠️ CCTV5 和 CCTV5+ 是两个台，绝不能合并");
        eq(Mirrors.normalize("CCTV5"), "cctv5", "CCTV5");
        eq(Mirrors.normalize("CCTV-5"), "cctv5", "CCTV-5");
        eq(Mirrors.normalize("CCTV5+"), "cctv5+", "CCTV5+ 的 + 必须留下");
        ok(!Mirrors.normalize("CCTV5+").equals(Mirrors.normalize("CCTV5")),
                "CCTV5+ 的 key 不许等于 CCTV5 的 key");
        ok(!Mirrors.normalize("CCTV-5+ 体育赛事").equals(Mirrors.normalize("CCTV-5")),
                "带后缀的 CCTV5+ 也不许撞上 CCTV5");
        eq(Mirrors.normalize("CCTV5＋"), "cctv5+", "全角 ＋ 经 NFKC 变半角（仍然是 +）");

        // 选路上也必须分开：给 CCTV5 挑镜像，不许挑到 CCTV5+ 去
        List<Source> all = list(
                src("CCTV5", "u://a"),
                src("CCTV5+", "u://b"),
                src("CCTV-5", "u://c"));
        Source nx = Mirrors.next(all, all.get(0), set("u://a"), null);
        eq(nx == null ? null : nx.url, "u://c", "CCTV5 的镜像只能是 CCTV-5，不能是 CCTV5+");
    }

    private static void t03_fullwidthAndCase() {
        section("03 全角 / 大小写");
        eq(Mirrors.normalize("ＣＣＴＶ１"), "cctv1", "全角字母数字 → 半角");
        eq(Mirrors.normalize("CCTV1"), Mirrors.normalize("ｃｃｔｖ１"), "半角与全角归一后相同");
        eq(Mirrors.normalize("  CCTV1  "), "cctv1", "首尾空格抹掉");
        // 土耳其语 locale 陷阱：默认 locale 下 "I".toLowerCase() 会变成无点 i。
        // 这里只要求「不受环境 locale 影响」，两种 locale 下结果必须一致。
        java.util.Locale old = java.util.Locale.getDefault();
        try {
            java.util.Locale.setDefault(new java.util.Locale("tr", "TR"));
            eq(Mirrors.normalize("CCTV-HD"), "cctv", "在 tr-TR 环境下归一化结果不变（Locale.ROOT）");
        } finally {
            java.util.Locale.setDefault(old);
        }
    }

    private static void t04_qualityTags() {
        section("04 尾部画质标签");
        eq(Mirrors.normalize("CCTV-6 (1080p)"), "cctv6", "(1080p)");
        eq(Mirrors.normalize("CCTV-8 (720p)"), "cctv8", "(720p)");
        eq(Mirrors.normalize("CCTV-10 (720p)"), "cctv10", "(720p) 带连字符");
        eq(Mirrors.normalize("CCTV1 HD"), "cctv1", " HD");
        eq(Mirrors.normalize("CCTV1 4K"), "cctv1", " 4K");
        eq(Mirrors.normalize("CCTV1 [UHD]"), "cctv1", " [UHD] 方括号");
        eq(Mirrors.normalize("CCTV1 （高清）"), "cctv1", "（高清）全角括号中文");
        eq(Mirrors.normalize("CCTV1 1080P HD"), "cctv1", "两层标签要连剥两轮");
        eq(Mirrors.normalize("CCTV1 1080p HD 蓝光"), "cctv1", "三层标签");
        // 剥不掉的情况：标签不在结尾
        eq(Mirrors.normalize("CCTV1 HD 综合"), "cctv1hd综合", "标签不在结尾就不剥（不乱猜）");
    }

    private static void t05_separatorsAndSpace() {
        section("05 分隔符");
        String want = "浙江卫视";
        eq(Mirrors.normalize("浙江 卫视"), want, "空格");
        eq(Mirrors.normalize("浙江-卫视"), want, "连字符");
        eq(Mirrors.normalize("浙江_卫视"), want, "下划线");
        eq(Mirrors.normalize("浙江·卫视"), want, "间隔号");
        eq(Mirrors.normalize("浙江.卫视"), want, "句点");
        eq(Mirrors.normalize("浙江、卫视"), want, "顿号");
        eq(Mirrors.normalize("浙江：卫视"), want, "冒号");
        eq(Mirrors.normalize("浙江｜卫视"), want, "竖线");
        eq(Mirrors.normalize("浙江/卫视"), want, "斜杠");
    }

    private static void t06_nbsp() {
        section("06 NBSP / 不可见字符（从网页复制台名常带）");
        // 这几个字符肉眼完全看不见，却会让「浙江卫视」和「浙江\u200b卫视」变成两个台
        eq(Mirrors.normalize("浙江\u00a0卫视"), "浙江卫视", "NBSP");
        eq(Mirrors.normalize("CCTV1\u00a0(720p)"), "cctv1", "NBSP + 画质标签");
        eq(Mirrors.normalize("\u3000CCTV1\u3000"), "cctv1", "全角空格");
        eq(Mirrors.normalize("浙江\u200b卫视"), "浙江卫视",
                "零宽空格 U+200B（既不是 isWhitespace 也不是 isSpaceChar）");
        eq(Mirrors.normalize("\ufeffCCTV1"), "cctv1", "BOM");
        eq(Mirrors.normalize("CCTV1\u200d"), "cctv1", "零宽连接符");
    }

    private static void t07_doNotOvermerge() {
        section("07 ⚠️ 不许过度合并（这是最危险的失败方向）");
        ok(!Mirrors.normalize("CCTV1").equals(Mirrors.normalize("CCTV11")),
                "CCTV1 与 CCTV11 不是同一个台");
        ok(!Mirrors.normalize("CCTV1").equals(Mirrors.normalize("CCTV2")),
                "CCTV1 与 CCTV2 不是同一个台");
        ok(!Mirrors.normalize("湖南卫视").equals(Mirrors.normalize("湖南经视")),
                "湖南卫视 与 湖南经视 不是同一个台");
        ok(!Mirrors.normalize("CCTV-4").equals(Mirrors.normalize("CCTV-4 中文国际")),
                "CCTV-4 与「CCTV-4 中文国际」保守地不合并（宁愿少退一路，也不退错台）");
        // 画质标签剥离后仍要能区分台
        ok(!Mirrors.normalize("CCTV1 高清").equals(Mirrors.normalize("CCTV2 高清")),
                "剥掉「高清」之后仍要能区分台");
    }

    private static void t08_emptyNameNoGrouping() {
        section("08 ⚠️ 没有台名的源不参与镜像分组");
        eq(Mirrors.normalize(null), "", "null → 空 key");
        eq(Mirrors.normalize(""), "", "空串 → 空 key");
        eq(Mirrors.normalize("   "), "", "纯空白 → 空 key");
        eq(Mirrors.normalize("---"), "", "纯分隔符 → 空 key");
        eq(Mirrors.normalize("(1080p)"), "", "只有一个画质标签 → 空 key");

        eq(Mirrors.key(src(null, "u://a")), "", "Source 名字为 null → 空 key");
        eq(Mirrors.key(src("", "u://a")), "", "Source 名字为空串 → 空 key");
        eq(Mirrors.key(src("CCTV1", "u://a")), "cctv1", "正常名字");

        // 关键：两个匿名源不许被当成同一个台
        List<Source> all = list(src(null, "u://a"), src(null, "u://b"), src("", "u://c"));
        eq(Mirrors.next(all, all.get(0), set("u://a"), null), null,
                "匿名源之间不许互相顺延");
        eq(Mirrors.count(all, all.get(0)), 1, "匿名源的台内路数是 1（= 没有镜像）");

        // iptv_realworld_test 里那条人为死链就是这个形态：POST /api/add 裸地址，不带名字
        List<Source> withNamed = list(src(null, "http://127.0.0.1:1/dead.m3u8"),
                src("CCTV1", "u://x"), src("CCTV-1", "u://y"));
        eq(Mirrors.next(withNamed, withNamed.get(0), set("http://127.0.0.1:1/dead.m3u8"), null),
                null, "匿名死链不会去蹭同名台的镜像");
    }

    private static void t09_chineseQualityTag() {
        section("09 中文画质标签");
        eq(Mirrors.normalize("湖南卫视高清"), "湖南卫视", "高清");
        eq(Mirrors.normalize("湖南卫视-高清"), "湖南卫视", "连字符 + 高清");
        eq(Mirrors.normalize("湖南卫视超清"), "湖南卫视", "超清");
        eq(Mirrors.normalize("湖南卫视 标清"), "湖南卫视", "标清");
        // 于是这两条会归到一组，正是我们想要的
        eq(Mirrors.normalize("湖南卫视高清"), Mirrors.normalize("湖南卫视"),
                "「湖南卫视高清」与「湖南卫视」同一个台");
    }

    private static void t10_idempotent() {
        section("10 归一化是幂等的");
        String[] xs = {"CCTV-1 (720p)", "ＣＣＴＶ－１", "CCTV1 1080P HD", "浙江·卫视", "CCTV5+"};
        for (String x : xs) {
            String once = Mirrors.normalize(x);
            eq(Mirrors.normalize(once), once, "normalize(normalize(" + x + "))");
        }
    }

    // =====================================================================
    // 选路
    // =====================================================================

    private static void t11_count() {
        section("11 count()");
        List<Source> all = list(
                src("CCTV1", "u://1"),
                src("CCTV-1", "u://2"),
                src("CCTV-1 (720p)", "u://3"),
                src("CCTV2", "u://4"));
        eq(Mirrors.count(all, all.get(0)), 3, "CCTV1 这一族 3 路");
        eq(Mirrors.count(all, all.get(3)), 1, "CCTV2 只有 1 路");
        eq(Mirrors.count(all, null), 1, "null → 1");
    }

    private static void t12_nextInPlaylistOrder() {
        section("12 next() 按清单顺序挑");
        List<Source> all = list(
                src("CCTV1", "u://1"),
                src("CCTV-1", "u://2"),
                src("CCTV-1 (720p)", "u://3"));
        eq(Mirrors.next(all, all.get(0), set("u://1"), null).url, "u://2", "第一条失败 → 第二条");
        eq(Mirrors.next(all, all.get(0), set("u://1", "u://2"), null).url, "u://3",
                "前两条都试过 → 第三条");
    }

    private static void t13_nextSkipsTried() {
        section("13 next() 跳过试过的");
        List<Source> all = list(src("CCTV1", "u://1"), src("CCTV-1", "u://2"), src("CCTV1", "u://3"));
        eq(Mirrors.next(all, all.get(0), set("u://1", "u://3"), null).url, "u://2",
                "跳过试过的 3，回到没试过的 2（仍按清单顺序，不是按试过的顺序）");
    }

    private static void t14_nextPrefersFreshOverBad() {
        section("14 next() 更偏好「本次没失败过」的");
        List<Source> all = list(src("CCTV1", "u://1"), src("CCTV-1", "u://2"), src("CCTV1", "u://3"));
        // 2、3 都没试过，但 2 以前失败过 → 应该先挑 3
        eq(Mirrors.next(all, all.get(0), set("u://1"), set("u://2")).url, "u://3",
                "u://2 失败过 → 先挑 u://3");
        // 3 也失败过 → 只能回到 2
        eq(Mirrors.next(all, all.get(0), set("u://1"), set("u://2", "u://3")).url, "u://2",
                "两个都失败过 → 垫底挑 u://2（给抖动一次机会）");
    }

    private static void t15_nextExhausted() {
        section("15 next() 走完了返回 null");
        List<Source> all = list(src("CCTV1", "u://1"), src("CCTV-1", "u://2"));
        eq(Mirrors.next(all, all.get(0), set("u://1", "u://2"), null), null, "全试完 → null");
        eq(Mirrors.next(list(src("CCTV2", "u://9")), src("CCTV2", "u://9"), set("u://9"), null),
                null, "单路台 → null");
    }

    private static void t16_nextLastResortBad() {
        section("16 next() 的垫底分支（都失败过时仍给一次机会）");
        List<Source> all = list(src("CCTV1", "u://1"), src("CCTV-1", "u://2"));
        Source nx = Mirrors.next(all, all.get(0), set("u://1"), set("u://2"));
        ok(nx != null && "u://2".equals(nx.url), "都失败过 → 仍然返回 u://2（失败可能是抖动）");
    }

    private static void t17_nextEmptyKeyGivesUp() {
        section("17 next() 对无台名一律放弃");
        List<Source> all = list(src(null, "u://1"), src(null, "u://2"));
        eq(Mirrors.next(all, all.get(0), set("u://1"), null), null, "匿名 → 放弃");
        eq(Mirrors.next(null, all.get(0), null, null), null, "源表为 null → 放弃");
        eq(Mirrors.next(all, null, null, null), null, "当前源为 null → 放弃");
    }

    private static void t18_realPlaylistShape() {
        section("18 真实清单的形态（cn_all.m3u8 的节选）");
        // 这份节选照抄真实清单里最容易出错的几族：
        //   CCTV-1   有 3 种写法      CCTV-5 / CCTV5+ 必须分开
        //   CCTV-9   有 2 种写法      CCTV-4 与 CCTV-4 中文国际 保守不合并
        List<Source> all = list(
                src("CCTV-1", "u://1a"),
                src("CCTV1", "u://1b"),
                src("CCTV-1 (720p)", "u://1c"),
                src("CCTV5", "u://5a"),
                src("CCTV-5", "u://5b"),
                src("CCTV5+", "u://5p1"),
                src("CCTV5+", "u://5p2"),
                src("CCTV-9", "u://9a"),
                src("CCTV9", "u://9b"),
                src("CCTV-4", "u://4a"),
                src("CCTV-4 中文国际", "u://4b"),
                src("湖南卫视", "u://hn1"),
                src("湖南卫视高清", "u://hn2"));

        eq(Mirrors.count(all, all.get(0)), 3, "CCTV-1 一族 = 3 路");
        eq(Mirrors.count(all, all.get(3)), 2, "CCTV5 = 2 路（不含 CCTV5+）");
        eq(Mirrors.count(all, all.get(5)), 2, "CCTV5+ = 2 路（不含 CCTV5）");
        eq(Mirrors.count(all, all.get(7)), 2, "CCTV-9 一族 = 2 路");
        eq(Mirrors.count(all, all.get(9)), 1, "CCTV-4 = 1 路（中文国际那条不并进来）");
        eq(Mirrors.count(all, all.get(11)), 2, "湖南卫视 + 湖南卫视高清 = 2 路");

        // 从 CCTV5 出发，走两步能覆盖它自己这一族，且一步都没踏进 CCTV5+
        Set<String> tried = new LinkedHashSet<>();
        tried.add("u://5a");
        Source n1 = Mirrors.next(all, all.get(3), tried, null);
        eq(n1 == null ? null : n1.url, "u://5b", "CCTV5 的下一路");
        tried.add("u://5b");
        eq(Mirrors.next(all, all.get(4), tried, null), null,
                "CCTV5 走完就没了，绝不顺延到 CCTV5+");
    }

    private static void t19_policyConstants() {
        section("19 策略常量");
        ok(Mirrors.MAX_ATTEMPTS >= 2, "至少要有一次自动顺延，否则功能等于没有");
        ok(Mirrors.MAX_ATTEMPTS <= 6,
                "上限不该太大：真实清单实测死链 p50 失败耗时 5002ms，每多一路就是多等约 5 秒");
        ok(Mirrors.WALK_BUDGET_MS >= 15000L,
                "总预算至少容得下一次起播看门狗（CustomActivity.PREPARE_TIMEOUT_MS = 15000）");
        ok(Mirrors.WALK_BUDGET_MS < 120000L, "总预算不该长到用户以为死机");
    }

    private static void t20_nextIgnoresOtherChannels() {
        section("20 next() 只在自己这一族里找");
        List<Source> all = list(
                src("CCTV1", "u://1"),
                src("CCTV2", "u://2"),
                src("CCTV3", "u://3"),
                src("CCTV11", "u://11"));
        eq(Mirrors.next(all, all.get(0), set("u://1"), null), null,
                "CCTV1 没有同族地址时，不许拿 CCTV2/CCTV3/CCTV11 顶上");
        // 不同分组也算同一个台（分组只是 tab，不影响「是不是同一个台」）
        List<Source> byGroup = list(
                src("CCTV1", "u://1", "央视"),
                src("CCTV-1", "u://2", "内地"));
        eq(Mirrors.next(byGroup, byGroup.get(0), set("u://1"), null).url, "u://2",
                "跨分组仍算同一个台");
    }
}
