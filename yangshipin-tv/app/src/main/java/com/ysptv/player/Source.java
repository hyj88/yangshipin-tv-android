package com.ysptv.player;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 一条自定义播放源。
 *
 * ⚠️ 本类【刻意】不使用任何 Android API —— 也不碰 JSON。
 *    这样 {@link M3uParser} 和它可以在宿主 JVM 上直接被 javac 编译 + 跑单测
 *    （见 tools/custom_source_test.mjs），不必开模拟器就能验证解析逻辑。
 *    序列化是 {@link SourceStore} 的事，那边才用 org.json。
 */
final class Source {

    /** 显示名，例如「CCTV-1 综合」 */
    String name;

    /** 播放地址（已把尾部 |请求头 部分剥掉） */
    String url;

    /** 分组名，来自 m3u 的 group-title（可能为空） */
    String group;

    /**
     * 这一条是**从哪份清单来的**（v1.11 新增，键名 "f"；空 = 用户自己手加的）。
     *
     * ⚠️ 为什么需要这个字段：没有它，「退订这份清单」和「刷新时把失效条目删掉」
     *    这两件事在逻辑上**做不到** —— App 只知道「现在有这些条目」，
     *    不知道「哪些是这份清单带来的、哪些是我自己加的」。
     *    合并式刷新（只增不删）就是被这个信息缺失逼出来的。
     *
     * ⚠️ 存的是**清单 URL**，不是清单内容的哈希：同一个地址重新拉一遍，
     *    就能对上号；而地址变了就当成另一份订阅，旧的那些不会被误删。
     *
     * 老数据（1.10 及以前存的）没有这个字段 → 解析出来是 null →
     * 一律当作「自己手加的」，同步删除时**不会碰它们**（保守，见 SourceStore.syncFrom）。
     */
    String from;

    /**
     * 播放时附加的 HTTP 请求头。
     *
     * 现实里大量 IPTV 源是「裸 m3u8 会被 403」的，必须带 Referer / User-Agent
     * 才放行。这些信息在 m3u 里的写法五花八门：
     *     http://a/b.m3u8|User-Agent=Mozilla/5.0&Referer=http://c/
     *     #EXTVLCOPT:http-referrer=http://c/
     * 解析后统一收在这里，播放时交给 MediaPlayer。
     */
    final Map<String, String> headers = new LinkedHashMap<>();

    Source() {}

    Source(String name, String url, String group) {
        this.name = name;
        this.url = url;
        this.group = group;
    }

    /** 带来源的构造（从某份清单导入时用） */
    Source(String name, String url, String group, String from) {
        this(name, url, group);
        this.from = (from == null || from.trim().isEmpty()) ? null : from.trim();
    }

    /** 这条是不是从这份清单来的（from 为 null 的老数据/手加项一律 false） */
    boolean fromList(String listUrl) {
        return from != null && listUrl != null && from.equals(listUrl);
    }

    /** 去掉空格的显示名，空则用 URL 兜底 —— 列表里不能出现空白行 */
    String display() {
        if (name != null && !name.trim().isEmpty()) return name.trim();
        if (url != null && !url.isEmpty()) return shortUrl(url);
        return "(未命名)";
    }

    String groupOr(String fallback) {
        if (group != null && !group.trim().isEmpty()) return group.trim();
        return fallback;
    }

    /** 列表里放不下整条 URL，截成 "host/末段" 的样子 */
    static String shortUrl(String url) {
        String s = url;
        int q = s.indexOf('?');
        if (q > 0) s = s.substring(0, q);
        int i = s.indexOf("://");
        if (i > 0) s = s.substring(i + 3);
        if (s.length() > 46) s = s.substring(0, 22) + "…" + s.substring(s.length() - 20);
        return s;
    }

    /**
     * 两条源是不是同一个 —— 只认 URL（请求头不同不影响去重）。
     * 用来做导入去重、以及标记「正在播放」那一行。
     */
    boolean sameAs(Source o) {
        return o != null && sameAsUrl(o.url);
    }

    /** 便捷版：直接拿 URL 比（JS 桥回传的是 URL，不是下标） */
    boolean sameAsUrl(String u) {
        return url != null && u != null && url.equals(u);
    }

    @Override
    public String toString() {
        return display() + " [" + (group == null ? "" : group) + "] " + url
                + (headers.isEmpty() ? "" : " +" + headers.size() + "头");
    }
}
