package com.ysptv.player;

import java.util.List;
import java.util.Map;

/**
 * M3uParser / Source 的宿主 JVM 单测（不需要 Android、不需要模拟器）。
 *
 * 用法（由 tools/custom_source_test.mjs 调起，也可手工跑）：
 *   javac -d /tmp/m3utest -encoding UTF-8 tools/hosttest/M3uParserTest.java \
 *         yangshipin-tv/app/src/main/java/com/hyj/ysptv/{Source,M3uParser}.java
 *   java -Dfile.encoding=UTF-8 -cp /tmp/m3utest com.ysptv.player.M3uParserTest
 *
 * 退出码 0 = 全过；非 0 = 有失败（并打印详情）。
 */
public final class M3uParserTest {

    private static int pass = 0;
    private static int fail = 0;

    public static void main(String[] args) {
        t01_standardExtinf();
        t02_groupTitleWithComma();
        t03_tvgNameFallback();
        t04_extgrpDirective();
        t05_urlTailHeaders();
        t06_exvllcoptHeaders();
        t07_bareUrlLines();
        t08_singleUrlFlexible();
        t09_mediaManifestRejected();
        t10_segmentLinesSkipped();
        t11_tsSingleFileKept();
        t12_parseAttrsQuoting();
        t13_canonHeader();
        t14_lastCommaOutsideQuotes();
        t15_isStreamUrl();
        t16_shortUrlAndDisplay();
        t17_unknownSchemeDropped();
        t18_dedupeSameAs();
        t19_emptyAndGarbage();
        t20_percentEncodedPipe();
        t21_crlfAndBlankLines();
        t22_maxItemsCap();
        t23_stickyGroupAndHeaders();
        t24_extvlcoptAfterExtinf();
        t25_looksLikeChannelList();
        t26_isHtml();

        System.out.println();
        System.out.println("M3uParserTest: " + pass + " 过 / " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }

    // =====================================================================
    // 断言小工具
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

    // =====================================================================
    // 用例
    // =====================================================================

    private static void t01_standardExtinf() {
        section("01 标准 EXTINF");
        String m3u = "#EXTM3U\n"
                + "#EXTINF:-1 tvg-name=\"CCTV1\" group-title=\"央视\",CCTV-1 综合\n"
                + "http://a.example/cctv1.m3u8\n"
                + "#EXTINF:-1 tvg-name=\"CCTV2\" group-title=\"央视\",CCTV-2 财经\n"
                + "http://a.example/cctv2.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 2, "条数");
        eq(l.get(0).name, "CCTV-1 综合", "名称");
        eq(l.get(0).url, "http://a.example/cctv1.m3u8", "地址");
        eq(l.get(0).group, "央视", "分组");
        ok(l.get(0).headers.isEmpty(), "不该凭空多出请求头");
    }

    private static void t02_groupTitleWithComma() {
        section("02 group-title 里含逗号");
        String m3u = "#EXTM3U\n"
                + "#EXTINF:-1 group-title=\"测试, 备用\",频道甲\n"
                + "http://a.example/x.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 1, "条数");
        eq(l.get(0).group, "测试, 备用", "分组应含逗号");
        eq(l.get(0).name, "频道甲", "名称不该被逗号带偏");
    }

    private static void t03_tvgNameFallback() {
        section("03 没有标题时用 tvg-name");
        String m3u = "#EXTM3U\n"
                + "#EXTINF:-1 tvg-name=\"凤凰中文\", \n"
                + "http://a.example/fh.m3u8\n"
                + "#EXTINF:-1 tvg-name=\"翡翠台\"\n"
                + "http://a.example/jade.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 2, "条数");
        eq(l.get(0).name, "凤凰中文", "空白标题回落 tvg-name");
        eq(l.get(1).name, "翡翠台", "无逗号时回落 tvg-name");
    }

    private static void t04_extgrpDirective() {
        section("04 #EXTGRP 独立分组行");
        String m3u = "#EXTM3U\n"
                + "#EXTGRP:卫视\n"
                + "#EXTINF:-1,湖南卫视\n"
                + "http://a.example/hn.m3u8\n"
                + "#EXTINF:-1 group-title=\"央视\",CCTV-3\n"
                + "http://a.example/cctv3.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 2, "条数");
        eq(l.get(0).group, "卫视", "EXTGRP 生效");
        eq(l.get(1).group, "央视", "EXTINF 里的 group-title 压过 EXTGRP");
    }

    private static void t05_urlTailHeaders() {
        section("05 地址尾巴上的请求头");
        String m3u = "#EXTM3U\n"
                + "#EXTINF:-1,带头的台\n"
                + "http://a.example/h.m3u8|User-Agent=Mozilla/5.0&Referer=http://h.example/\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 1, "条数");
        eq(l.get(0).url, "http://a.example/h.m3u8", "地址应剥掉尾巴");
        eq(l.get(0).headers.get("User-Agent"), "Mozilla/5.0", "User-Agent");
        eq(l.get(0).headers.get("Referer"), "http://h.example/", "Referer");
    }

    private static void t06_exvllcoptHeaders() {
        section("06 #EXTVLCOPT 请求头");
        String m3u = "#EXTM3U\n"
                + "#EXTVLCOPT:http-referrer=http://r.example/\n"
                + "#EXTVLCOPT:http-user-agent=VLC/3.0\n"
                + "#EXTINF:-1,某台\n"
                + "http://a.example/v.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 1, "条数");
        eq(l.get(0).headers.get("Referer"), "http://r.example/", "http-referrer → Referer");
        eq(l.get(0).headers.get("User-Agent"), "VLC/3.0", "http-user-agent → User-Agent");
    }

    private static void t07_bareUrlLines() {
        section("07 光秃秃的地址行");
        String m3u = "http://a.example/1.m3u8\n"
                + "\n"
                + "http://a.example/2.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 2, "条数");
        eq(l.get(0).group, "自建", "无分组时用默认分组");
        ok(l.get(0).name == null, "没有名字时留空（由界面兜底显示）");
        ok(l.get(0).display().length() > 0, "display() 必须有内容，列表不能出现空白行");
    }

    private static void t08_singleUrlFlexible() {
        section("08 parseFlexible 单条地址");
        List<Source> l = M3uParser.parseFlexible(
                "  https://x.example/a/b.m3u8  ", "我的台", "自建");
        eq(l.size(), 1, "条数");
        eq(l.get(0).name, "我的台", "用调用方给的名字");
        eq(l.get(0).url, "https://x.example/a/b.m3u8", "地址已 trim");

        // 带尾巴请求头的一行也要认
        List<Source> l2 = M3uParser.parseFlexible(
                "https://x.example/live.m3u8|Referer=https://x.example/", "带 referer", null);
        eq(l2.size(), 1, "带头的单行也认");
        eq(l2.get(0).headers.get("Referer"), "https://x.example/", "头解析出来了");
        eq(l2.get(0).group, "自建", "null 分组落到默认值");
    }

    private static void t09_mediaManifestRejected() {
        section("09 单个流的清单不能当频道表");
        String media = "#EXTM3U\n"
                + "#EXT-X-VERSION:3\n"
                + "#EXT-X-TARGETDURATION:10\n"
                + "#EXT-X-MEDIA-SEQUENCE:0\n"
                + "#EXTINF:10.000,\n"
                + "seg0.ts\n"
                + "#EXTINF:10.000,\n"
                + "seg1.ts\n";
        List<Source> l = M3uParser.parseFlexible(media, "", "自建");
        eq(l.size(), 0, "媒体清单应被整体拒绝");
        ok(M3uParser.LAST_IS_SINGLE_MANIFEST, "应标记 LAST_IS_SINGLE_MANIFEST");

        String master = "#EXTM3U\n"
                + "#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=640x360\n"
                + "360/index.m3u8\n"
                + "#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720\n"
                + "720/index.m3u8\n";
        List<Source> l2 = M3uParser.parseFlexible(master, "", "自建");
        eq(l2.size(), 0, "master 清单同样拒绝");
        ok(M3uParser.LAST_IS_SINGLE_MANIFEST, "master 也应打标记");
    }

    private static void t10_segmentLinesSkipped() {
        section("10 分片行要跳过（解析器层面）");
        String mixed = "#EXTM3U\n"
                + "#EXT-X-TARGETDURATION:6\n"
                + "#EXTINF:6.000,\n"
                + "seg0.ts?token=abc\n"
                + "#EXTINF:6.000,\n"
                + "seg1.ts\n";
        eq(M3uParser.parse(mixed, "自建").size(), 0, "分片不该变成频道");
    }

    private static void t11_tsSingleFileKept() {
        section("11 单文件 .ts 源不能被误杀");
        String m3u = "#EXTM3U\n"
                + "#EXTINF:-1 group-title=\"单文件\",某路直播\n"
                + "http://a.example/ch1.ts\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 1, "没有分片清单标记时 .ts 要保留");
        eq(l.get(0).url, "http://a.example/ch1.ts", "地址");
    }

    private static void t12_parseAttrsQuoting() {
        section("12 属性解析");
        Map<String, String> a = M3uParser.parseAttrs(
                " tvg-id=\"cctv1\" tvg-name='甲' group-title=\"央 视\" x=1 ");
        eq(a.get("tvg-id"), "cctv1", "双引号");
        eq(a.get("tvg-name"), "甲", "单引号");
        eq(a.get("group-title"), "央 视", "值里的空格");
        eq(a.get("x"), "1", "无引号");
    }

    private static void t13_canonHeader() {
        section("13 请求头名归一化");
        eq(M3uParser.canonHeader("user-agent"), "User-Agent", "user-agent");
        eq(M3uParser.canonHeader("http-user-agent"), "User-Agent", "http-user-agent");
        eq(M3uParser.canonHeader("Referrer"), "Referer", "Referrer");
        eq(M3uParser.canonHeader("tvg-logo"), null, "tvg-logo 不是请求头");
        eq(M3uParser.canonHeader("group-title"), null, "group-title 不是请求头");
        eq(M3uParser.canonHeader("X-Token"), "X-Token", "自定义 X- 头放行");
        eq(M3uParser.canonHeader("Bad Header"), null, "非法名字丢弃");
    }

    private static void t14_lastCommaOutsideQuotes() {
        section("14 引号外最后一个逗号");
        eq(M3uParser.lastIndexOfOutsideQuotes("#EXTINF:-1 tvg-name=\"A, B\",频道甲"),
                "#EXTINF:-1 tvg-name=\"A, B\"".length(), "引号里的逗号不算");
        eq(M3uParser.lastIndexOfOutsideQuotes("abc,def,ghi"), 7, "普通情况取最后一个");
        eq(M3uParser.lastIndexOfOutsideQuotes("没有逗号"), -1, "没有逗号");
    }

    private static void t15_isStreamUrl() {
        section("15 协议白名单");
        ok(M3uParser.isStreamUrl("http://a/b.m3u8"), "http");
        ok(M3uParser.isStreamUrl("HTTPS://A/B.M3U8"), "https 大写");
        ok(M3uParser.isStreamUrl("rtsp://a/b"), "rtsp");
        ok(!M3uParser.isStreamUrl("file:///sdcard/a.m3u8"), "file 不收");
        ok(!M3uParser.isStreamUrl("cctv1"), "光名字不算地址");
        ok(!M3uParser.isStreamUrl(""), "空");
    }

    private static void t16_shortUrlAndDisplay() {
        section("16 兜底显示名");
        Source s = new Source(null, "https://cdn.example.com/live/very/long/path/"
                + "channel-name-here/stream.m3u8?token=123", "自建");
        // 首 22 字 + … + 末 20 字（写死是为了锁住截断规则，改了要一起改）
        eq(s.display(), "cdn.example.com/live/v…ame-here/stream.m3u8", "截断形态");
        ok(s.display().indexOf("token") < 0, "查询串要剥掉");
        eq(new Source("  ", null, null).display(), "(未命名)", "全空");
        eq(s.groupOr("X"), "自建", "group 有值");
        eq(new Source(null, null, "  ").groupOr("X"), "X", "group 全空回落");
    }

    private static void t17_unknownSchemeDropped() {
        section("17 非流地址被丢弃");
        String m3u = "#EXTM3U\n"
                + "#EXTINF:-1,垃圾行\n"
                + "not a url at all\n"
                + "#EXTINF:-1,本地文件\n"
                + "file:///sdcard/x.m3u8\n"
                + "#EXTINF:-1,正经台\n"
                + "http://a.example/ok.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 1, "只留能播的那条");
        eq(l.get(0).name, "正经台", "留下的正是它");
    }

    private static void t18_dedupeSameAs() {
        section("18 同一性判定");
        Source a = new Source("甲", "http://a/x.m3u8", "A");
        Source b = new Source("乙", "http://a/x.m3u8", "B");
        Source c = new Source("甲", "http://a/y.m3u8", "A");
        ok(a.sameAs(b), "同地址即同一条（名字分组无关）");
        ok(!a.sameAs(c), "地址不同即不同");
        ok(!a.sameAs(null), "null 安全");
    }

    private static void t19_emptyAndGarbage() {
        section("19 空输入 / 乱码");
        eq(M3uParser.parse(null, "自建").size(), 0, "null");
        eq(M3uParser.parse("", "自建").size(), 0, "空串");
        eq(M3uParser.parse("\n\n\n", "自建").size(), 0, "全空行");
        eq(M3uParser.parse("#EXTM3U\n", "自建").size(), 0, "只有头");
        eq(M3uParser.parseFlexible(null, "x", null).size(), 0, "parseFlexible null");
        eq(M3uParser.parseFlexible("   ", "x", null).size(), 0, "parseFlexible 全空白");
    }

    private static void t20_percentEncodedPipe() {
        section("20 %7C 形式的竖线");
        List<Source> l = M3uParser.parseFlexible(
                "http://a.example/p.m3u8%7CUser-Agent=UA1", "带编码竖线", "自建");
        eq(l.size(), 1, "条数");
        eq(l.get(0).headers.get("User-Agent"), "UA1", "编码竖线也能解析");
    }

    private static void t21_crlfAndBlankLines() {
        section("21 CRLF + 多余空行 + 缩进");
        String m3u = "#EXTM3U\r\n"
                + "\r\n"
                + "  #EXTINF:-1 group-title=\"甲\",频道一  \r\n"
                + "\t http://a.example/1.m3u8 \r\n"
                + "\r\n"
                + "#EXTINF:-1 group-title=\"乙\",频道二\r\n"
                + "http://a.example/2.m3u8\r\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 2, "条数");
        eq(l.get(0).name, "频道一", "名称已 trim");
        eq(l.get(0).url, "http://a.example/1.m3u8", "地址已 trim");
        eq(l.get(1).group, "乙", "第二条分组");
    }

    private static void t22_maxItemsCap() {
        section("22 超量导入截断");
        StringBuilder sb = new StringBuilder("#EXTM3U\n");
        for (int i = 0; i < M3uParser.MAX_ITEMS + 250; i++) {
            sb.append("#EXTINF:-1,台").append(i).append('\n')
              .append("http://a.example/").append(i).append(".m3u8\n");
        }
        List<Source> l = M3uParser.parseFlexible(sb.toString(), "x", "自建");
        eq(l.size(), M3uParser.MAX_ITEMS, "应被截到上限");
        eq(l.get(0).url, "http://a.example/0.m3u8", "截的是尾巴不是头");
    }

    private static void t23_stickyGroupAndHeaders() {
        section("23 EXTGRP / EXTVLCOPT 是文件级粘性设置");
        // 真实列表的典型形态：开头一段全局设置，后面几十个台都吃它
        String m3u = "#EXTM3U\n"
                + "#EXTVLCOPT:http-user-agent=GlobalUA/1.0\n"
                + "#EXTGRP:央视\n"
                + "#EXTINF:-1,CCTV-1\n"
                + "http://a.example/1.m3u8\n"
                + "#EXTINF:-1,CCTV-2\n"
                + "http://a.example/2.m3u8\n"
                + "#EXTGRP:卫视\n"
                + "#EXTINF:-1,湖南卫视\n"
                + "http://a.example/3.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 3, "条数");
        eq(l.get(0).group, "央视", "第 1 条分组");
        eq(l.get(1).group, "央视", "第 2 条继承前一行 EXTGRP");
        eq(l.get(2).group, "卫视", "第 3 条跟着新的 EXTGRP");
        eq(l.get(0).headers.get("User-Agent"), "GlobalUA/1.0", "全局 UA 作用于第 1 条");
        eq(l.get(2).headers.get("User-Agent"), "GlobalUA/1.0", "也作用于最后一条");
    }

    private static void t24_extvlcoptAfterExtinf() {
        section("24 EXTVLCOPT 写在 EXTINF 之后（另一种常见顺序）");
        String m3u = "#EXTM3U\n"
                + "#EXTINF:-1,某台\n"
                + "#EXTVLCOPT:http-user-agent=UA2\n"
                + "http://a.example/x.m3u8\n";
        List<Source> l = M3uParser.parse(m3u, "自建");
        eq(l.size(), 1, "条数");
        eq(l.get(0).headers.get("User-Agent"), "UA2", "两种顺序都要认");
    }

    private static void t25_looksLikeChannelList() {
        section("25 looksLikeChannelList：抓回来的东西到底是不是频道列表");
        // 这一段是「从网址导入」的判定核心。判错的两种后果都写在 M3uParser 的注释里了，
        // 所以各种形态都摆出来钉住。

        String list = "#EXTM3U\n"
                + "#EXTINF:-1 group-title=\"央视\",CCTV-1 综合\n"
                + "http://a.example/cctv1.m3u8\n"
                + "#EXTINF:-1 group-title=\"卫视\",湖南卫视\n"
                + "http://a.example/hunan.m3u8\n";
        ok(M3uParser.looksLikeChannelList(list), "标准两份台 → 是频道列表");

        String one = "#EXTM3U\n#EXTINF:-1,只有一个台\nhttp://a.example/only.m3u8\n";
        ok(M3uParser.looksLikeChannelList(one), "只有一条台的清单也是清单");

        // 单个流自己的清单：绝不能当频道表（否则会导入一堆指 .ts 的假频道）
        String media = "#EXTM3U\n"
                + "#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:99\n"
                + "#EXTINF:6.000,\nseg-99.ts\n#EXTINF:6.000,\nseg-100.ts\n";
        ok(!M3uParser.looksLikeChannelList(media), "媒体清单（分片表）→ 不是");
        ok(M3uParser.isStreamManifest(media), "  并且 isStreamManifest 认得出它");

        String master = "#EXTM3U\n"
                + "#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\nv1/index.m3u8\n"
                + "#EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360\nv0/index.m3u8\n";
        ok(!M3uParser.looksLikeChannelList(master), "master（多码率）→ 不是");

        String html = "<!DOCTYPE html>\n<html><head><title>请先登录</title></head><body>"
                + "<a href=\"http://a.example/x.m3u8\">a</a><a href=\"http://a.example/y.m3u8\">b</a>"
                + "</body></html>\n";
        ok(M3uParser.isHtml(html), "HTML 认得出");
        ok(!M3uParser.looksLikeChannelList(html), "HTML 页（哪怕有两个 http 链接）→ 不是频道列表");

        String noHeader = "http://a.example/x.m3u8\nhttp://a.example/y.m3u8\n";
        ok(M3uParser.looksLikeChannelList(noHeader), "没有 #EXTM3U 但两行地址也算（有些导出工具就这样）");

        ok(!M3uParser.looksLikeChannelList(""), "空串 → 不是");
        ok(!M3uParser.looksLikeChannelList(null), "null → 不是（不能抛）");
        ok(!M3uParser.looksLikeChannelList("随便一段中文，没有任何地址"), "没有地址的文本 → 不是");
        ok(!M3uParser.looksLikeChannelList("http://a.example/only-one.m3u8\n"),
                "只有一行地址、又没有 #EXTM3U → 不是（这就是「一路直播流」的形态）");
    }

    private static void t26_isHtml() {
        section("26 isHtml：几种真实碰到过的网页形态");
        ok(M3uParser.isHtml("<!DOCTYPE html><html></html>"), "标准 doctype");
        ok(M3uParser.isHtml("<html lang=\"zh\">"), "小写 html");
        ok(M3uParser.isHtml("<HTML>"), "大写 HTML");
        ok(M3uParser.isHtml("  \n<head><meta charset=utf-8>"), "前面有空白 + head");
        ok(!M3uParser.isHtml("#EXTM3U\n#EXTINF:-1,台\nhttp://a.example/x.m3u8\n"),
                "m3u 不会被误判成网页");
        ok(!M3uParser.isHtml(null), "null 安全");
    }
}
