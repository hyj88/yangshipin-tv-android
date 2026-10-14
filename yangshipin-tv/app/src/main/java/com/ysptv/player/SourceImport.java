package com.ysptv.player;

import android.content.Context;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * 「把用户给的东西变成源列表」的收口点。
 *
 * ==========================================================================
 * 三条输入路径，一个判断规则
 * ==========================================================================
 *   ① 一整段文本（局域网页面粘的 m3u、或本地拼出来的内容）→ {@link #importText}
 *   ② 一个网址（局域网页面的「从网址导入」、屏上键盘的「地址」栏）→ {@link #importUrl}
 *   ③ 上次用过的清单网址（电视上的「刷新远程清单」、局域网页面的「重新导入」）→ {@link #refreshRemote}
 *
 * ② 的规则是这一版的关键，也是唯一一处「需要联网才能知道用户给的是什么」的地方：
 *   **一个 http(s) 地址既可能是「一份频道清单」，也可能是「一路直播流」，
 *     光看地址分不出来**（两者常常都以 .m3u8 结尾）。所以先抓一次：
 *     · 抓回来是频道清单      → 整份导入，并把清单地址记住（以后可一键刷新）；
 *     · 抓回来是单个流自己的清单（master / 分片表）→ 把这个地址本身当一条源收下；
 *     · 抓不回来（断网/403/超时）→ 同样当一条源收下，但把失败原因写进提示里，
 *       免得「明明是网络问题，用户却以为地址错了」。
 *   注意「抓不到也照收」这一条：它保住了这一版之前的行为，不是妥协 ——
 *   有些源就是要特定请求头、或者只在播放器里能拉起来，抓取失败不等于播不了。
 *
 * ⚠️ 本类【会做网络 I/O】。凡在 Activity 里调用，必须放到后台线程
 *    （Android 3.0 起主线程联网直接抛 NetworkOnMainThreadException）。
 *    LanImportServer 那条路本来就在服务线程上，可以直接调。
 */
final class SourceImport {

    private static final String TAG = "YSPTV";

    /**
     * 抓取超时，比 {@link PlaylistFetcher} 的默认值短一点。
     *
     * 为什么单独一套：这两条路都是「用户正盯着屏幕等结果」（屏上键盘按完「保存」
     * 就停在那儿转）。默认 8s 连接 + 15s 读意味着最坏 23 秒静默，太长了。
     * 6s + 12s 对公网清单绰绰有余（43KB 的 cn_all.m3u8 实测 0.4s 级），
     * 而且超时也不丢东西 —— 地址照样按单条源收下。
     */
    private static final int PROBE_CONNECT_MS = 6000;
    private static final int PROBE_READ_MS = 12000;

    /** 一次导入的结果。字段够调用方自己组 JSON / 组提示，不用再各自算一遍。 */
    static final class Result {
        /** 这次导入算不算成功（「一条都没新增」也可能是成功，例如清单刷新后没有新台） */
        boolean ok;
        /** 导入的是整整一份**清单**（而不是一条源） */
        boolean isList;
        /** 是否真的发起过抓取（局域网页面要据此提示「这是远程清单」） */
        boolean fetched;
        /** 解析出的条数 */
        int parsed;
        /** 实际新增的条数（按 URL 去重后） */
        int added;
        /** 导入后源总数 */
        int total;
        /** 给用户看的一句话 */
        String msg = "";
        /** 抓取失败原因（空 = 没失败或没抓） */
        String fetchErr = "";
        /** 成功抓成清单时，真正取到内容的地址（跟完重定向之后的） */
        String listUrl = "";
        /** 同步刷新/退订时删掉的条数（上游已下架或改名） */
        int removed;
        /** 正在播的那条被删了 → 播放要重新起 */
        boolean playingRemoved;

        boolean isDuplicate() { return ok && added <= 0; }
    }

    private final Context app;

    SourceImport(Context ctx) {
        this.app = ctx.getApplicationContext();
    }

    // =====================================================================
    // ① 纯文本
    // =====================================================================

    /** 本地解析一段文本。不联网。 */
    Result importText(String text, String name) {
        Result r = new Result();
        if (text == null || text.trim().isEmpty()) {
            r.msg = "内容是空的";
            return r;
        }
        List<Source> parsed = M3uParser.parseFlexible(text, name, M3uParser.DEFAULT_GROUP);
        if (parsed.isEmpty()) {
            r.msg = M3uParser.LAST_IS_SINGLE_MANIFEST
                    ? "这看起来是【单个流自己的清单】（分片 / 多码率），不是频道列表。"
                      + "请把那个 .m3u8 的网址本身填进来。"
                    : "没解析出任何可播地址。支持 m3u/m3u8 播放列表，或者直接一行 http(s):// 地址。";
            return r;
        }
        r.parsed = parsed.size();
        r.added = SourceStore.merge(app, parsed);
        r.total = SourceStore.load(app).size();
        r.ok = true;
        r.msg = listMsg(r);
        return r;
    }

    // =====================================================================
    // ② 网址（会联网）
    // =====================================================================

    /**
     * 一个网址 → 源。可能导入一整份清单，也可能只收下这一条地址。
     * ⚠️ 阻塞（最多 8s 连接 + 15s 读），调用方要在后台线程。
     */
    Result importUrl(String url, String name) {
        Result r = new Result();
        String u = (url == null) ? "" : url.trim();
        if (u.isEmpty()) { r.msg = "地址不能为空"; return r; }
        if (!M3uParser.isStreamUrl(u)) {
            r.msg = "地址要以 http:// 或 https:// 开头";
            return r;
        }

        r.fetched = true;
        PlaylistFetcher.Result f = PlaylistFetcher.fetch(u, PROBE_CONNECT_MS, PROBE_READ_MS);

        if (!f.ok) {
            r.fetchErr = f.err;
            return single(r, name, u,
                    "没抓到清单（" + f.err + "），已把这个地址本身当成一条源收下");
        }

        if (!M3uParser.looksLikeChannelList(f.text)) {
            // 抓回来了，但不是频道清单 —— 地址本身才是能播的东西。
            // 三种情形分开说：这是一路直播流 / 这是一张网页 / 别的什么。
            // 分开说是值得的：第一种说明地址完全正常（只是它本身就是流），
            // 后两种则提示用户这个地址大概给错了。
            String note;
            if (M3uParser.isStreamManifest(f.text)) {
                note = "抓了一下，这是一路直播流本身（分片清单），已按单条源收下";
            } else if (M3uParser.isHtml(f.text)) {
                note = "抓回来是一张网页（可能要登录、或是「源已失效」提示页），已按单条源收下";
            } else {
                note = "抓回来的内容不像频道清单，已按单条源收下";
            }
            return single(r, name, u, note);
        }

        // ---- 确认是频道清单：整份导入 ----
        List<Source> parsed = M3uParser.parseFlexible(f.text, name, M3uParser.DEFAULT_GROUP);
        if (parsed.isEmpty()) {
            return single(r, name, u, "清单里没解析出可播地址，已把这个地址本身当成一条源收下");
        }
        r.isList = true;
        r.listUrl = f.finalUrl.isEmpty() ? u : f.finalUrl;
        r.parsed = parsed.size();
        // ⚠️ 打上「来自这份清单」的标记：这是后面「退订」和「刷新时同步删除」的地基
        r.added = SourceStore.merge(app, tagFrom(parsed, r.listUrl));
        r.total = SourceStore.load(app).size();
        r.ok = true;
        // 记住清单地址（刷新时要用，而且是跟完重定向之后那个）
        SourceStore.saveRemoteUrl(app, r.listUrl);
        r.msg = listMsg(r);
        if (r.added > 0) {
            r.msg += "。清单地址已记住，以后可以一键刷新";
        }
        return r;
    }

    // =====================================================================
    // ③ 刷新记住的清单
    // =====================================================================

    /**
     * 用记住的清单地址重新抓一次，并合并进列表。
     *
     * ⚠️ 语义是**合并去重，不删除**。App 里没有「这条源是从哪份清单来的」这个概念，
     *    所以做不到「把上次这份清单带来的、这次已经不在清单里的条目删掉」。
     *    硬要做就得给 Source 加来源字段、改存储格式 —— 那是另一件事。
     *    当前提示里会明说这一点，别让用户以为刷新等于同步。
     *    真要清干净，就是「清空全部源」→再刷新（清空时故意**保留**清单地址，
     *    就是为了让这条路走得通）。
     * ⚠️ 阻塞，调用方要在后台线程。
     */
    Result refreshRemote() {
        Result r = new Result();
        String u = SourceStore.loadRemoteUrl(app);
        if (u == null || u.isEmpty()) {
            r.msg = "还没有记住任何清单地址。先导入一次远程清单（局域网页面填网址，或屏上键盘填清单网址）。";
            return r;
        }
        r.fetched = true;
        PlaylistFetcher.Result f = PlaylistFetcher.fetch(u, PROBE_CONNECT_MS, PROBE_READ_MS);
        if (!f.ok) {
            r.fetchErr = f.err;
            r.msg = "刷新失败：" + f.err;
            return r;
        }
        if (!M3uParser.looksLikeChannelList(f.text)) {
            r.msg = "这个地址现在返回的不是频道清单（可能是单个流的清单，或一份错误页）";
            return r;
        }
        List<Source> parsed = M3uParser.parseFlexible(f.text, null, M3uParser.DEFAULT_GROUP);
        r.isList = true;
        r.listUrl = f.finalUrl.isEmpty() ? u : f.finalUrl;
        r.parsed = parsed.size();
        // ⚠️ 同步，不是合并：上游删掉的台这里也会被删掉（边界见 syncFrom 的注释）
        SourceStore.SyncResult sync = SourceStore.syncFrom(app, parsed, r.listUrl);
        r.added = sync.added;
        r.removed = sync.removed;
        r.playingRemoved = sync.playingRemoved;
        r.total = sync.total;
        r.ok = true;
        SourceStore.saveRemoteUrl(app, r.listUrl);
        r.msg = syncMsg(r);
        return r;
    }

    /**
     * 退订：删掉所有来自这份清单的条目。
     *
     * 手加的、从别的清单加的**一概不动**（边界在 {@link SourceStore#unlist} 里）。
     * 和「清空全部源」的差别有两个：只删这一份带来的；而且**连清单地址一起清掉** ——
     * 退订的语义恰恰是「我不要这份了」，留着地址就等于还能一键拉回来，那不叫退订。
     */
    Result unlistRemote() {
        Result r = new Result();
        String u = SourceStore.loadRemoteUrl(app);
        if (u == null || u.isEmpty()) {
            r.msg = "现在没有订阅任何清单，没什么可退订的。";
            return r;
        }
        r.listUrl = u;
        int n = SourceStore.unlist(app, u);
        r.removed = n;
        r.total = SourceStore.load(app).size();
        r.ok = true;
        SourceStore.clearRemoteUrl(app);
        r.msg = "已退订这份清单，删掉 " + n + " 条源"
                + (n == 0 ? "（没有属于它的条目，可能是 1.10 及以前导入的）" : "")
                + "。清单地址也一并清掉了";
        return r;
    }

    /** 同步刷新的说法：把「加了几条 / 删了几条」都说清楚，别让用户猜 */
    private static String syncMsg(Result r) {
        StringBuilder sb = new StringBuilder();
        sb.append("清单已更新：上游 ").append(r.parsed).append(" 条，新增 ")
          .append(r.added).append(" 条");
        if (r.removed > 0) {
            sb.append("，删掉 ").append(r.removed).append(" 条（上游已下架或改名）");
        }
        if (r.playingRemoved) sb.append("。正在播的那条被删了，换了一台");
        return sb.toString();
    }

    /** 记住的清单地址（空 = 没记住），给界面显示用 */
    String rememberedUrl() {
        return SourceStore.loadRemoteUrl(app);
    }

    // =====================================================================
    // 工具
    // =====================================================================

    /**
     * 给这批源打上「来自哪份清单」的标记（返回新列表，不就地改）。
     *
     * 刻意**复制**而不是就地改：parsed 里的对象可能被别的调用方复用
     * （局域网导入页把 text 解析一次、多处共享），就地改会串味。
     */
    private static List<Source> tagFrom(List<Source> src, String listUrl) {
        if (src == null || src.isEmpty() || listUrl == null || listUrl.isEmpty()) return src;
        List<Source> out = new ArrayList<>(src.size());
        for (Source s : src) {
            Source c = new Source(s.name, s.url, s.group, listUrl);
            c.headers.putAll(s.headers);
            out.add(c);
        }
        return out;
    }

    /** 把「这个网址本身」当成一条源收下 */
    private Result single(Result r, String name, String url, String note) {
        List<Source> one = M3uParser.parseFlexible(url, name, M3uParser.DEFAULT_GROUP);
        if (one.isEmpty()) {
            r.msg = "没认出来。地址要以 http:// 或 https:// 开头。";
            return r;
        }
        r.parsed = one.size();
        r.added = SourceStore.merge(app, one);
        r.total = SourceStore.load(app).size();
        r.ok = r.added > 0;
        r.msg = (r.added > 0
                    ? "已添加：" + one.get(0).display()
                    : "这条已经在列表里了（按网址去重）")
                + (note == null || note.isEmpty() ? "" : "。" + note);
        return r;
    }

    /** 清单导入的统一措辞（局域网页面和电视端共用，免得两处说法不一样） */
    private static String listMsg(Result r) {
        if (r.added > 0) {
            return "导入成功：" + r.added + " 条"
                    + (r.parsed > r.added ? "（清单里 " + r.parsed + " 条，重复的已跳过）" : "");
        }
        return r.parsed > 0
                ? "清单里 " + r.parsed + " 条，但都已经存在了（按网址去重）"
                : "清单是空的";
    }

    /** 出错时把原因也写进 logcat，排障不用猜 */
    static void logResult(String what, Result r) {
        if (r == null) return;
        if (r.ok) Log.i(TAG, what + " 完成：" + r.msg);
        else Log.w(TAG, what + " 未成功：" + r.msg + (r.fetchErr.isEmpty() ? "" : " / " + r.fetchErr));
    }
}
