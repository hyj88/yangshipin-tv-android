package com.ysptv.player;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * SourceStore.planSync / unlist 语义的宿主 JVM 单测（不需要 Android、不需要模拟器）。
 *
 * 为什么这个逻辑必须有单测：它是「会删用户数据」的那一类代码。
 * 删少了只是没解决问题，**删多了会把用户辛苦攒的真台清掉** ——
 * 而这种错在设备上跑一次才知道，跑一次可能就晚了。所以边界规则要能在
 * 几毫秒内反复验。
 *
 * planSync / unlist 刻意做成不碰 Context / SharedPreferences 的纯函数，就是为了这个。
 *
 * 用法（由 tools/custom_source_test.mjs 调起，也可手工跑）：
 *   javac -d /tmp/sync -encoding UTF-8 tools/hosttest/SourceSyncTest.java \
 *         yangshipin-tv/app/src/main/java/com/hyj/ysptv/{Source,SourceStore}.java
 *   java -Dfile.encoding=UTF-8 -cp /tmp/sync com.ysptv.player.SourceSyncTest
 *
 * 退出码 0 = 全过；非 0 = 有失败（并打印详情）。
 */
public final class SourceSyncTest {

    private static int pass = 0;
    private static int fail = 0;

    private static final String LIST_A = "http://a.example/cn.m3u8";
    private static final String LIST_B = "http://b.example/other.m3u8";

    public static void main(String[] args) {
        t01_sameListNothingChanges();
        t02_upstreamRemovedOne_isDeleted();
        t03_upstreamAddedOne_isAdded();
        t04_manualSourceNeverTouched();
        t05_otherListSourceNeverTouched();
        t06_legacySourceNoFrom_isKeptAndTagged();
        t07_secondSyncAfterTagging_deletes();
        t08_playingRemovedIsReported();
        t09_emptyListUrlIsNoop();
        t10_unlistOnlyOwnSources();
        t11_unlistKeepsManual();
        t12_unlistOtherList();
        t13_renameLooksLikeDeletePlusAdd();
        t14_emptyUpstreamDeletesAllOwned();
        t15_headersSurviveSync();
        t16_maxItemsRespected();

        System.out.println("SourceSyncTest: " + pass + " 过 / " + fail + " 失败");
        if (fail > 0) System.exit(1);
    }

    // ------------------------------------------------------------------
    // 用例
    // ------------------------------------------------------------------

    /** 清单没变 → 加 0 删 0，列表原样 */
    private static void t01_sameListNothingChanges() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                owned("B台", "http://a/2.m3u8", LIST_A));
        List<Source> up = new ArrayList<>(Arrays.asList(
                new Source("A台", "http://a/1.m3u8", "央视"),
                new Source("B台", "http://a/2.m3u8", "央视")));

        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("清单没变：加 0 删 0",
                r.added == 0 && r.removed == 0 && r.total == 2,
                "added=" + r.added + " removed=" + r.removed + " total=" + r.total);
        check("清单没变：列表还是那两条", urls(r.kept).equals(Arrays.asList(
                "http://a/1.m3u8", "http://a/2.m3u8")), urls(r.kept).toString());
    }

    /** 上游把一条删了 → 这条要从列表里消失（这是本功能存在的理由） */
    private static void t02_upstreamRemovedOne_isDeleted() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                owned("B台", "http://a/2.m3u8", LIST_A),
                owned("C台", "http://a/3.m3u8", LIST_A));
        List<Source> up = new ArrayList<>(Arrays.asList(
                new Source("A台", "http://a/1.m3u8", "央视"),
                new Source("C台", "http://a/3.m3u8", "央视")));

        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("上游删掉的台会被删掉（removed=1）", r.removed == 1,
                "removed=" + r.removed + " kept=" + urls(r.kept));
        check("被删的那条确实不在列表里了",
                !urls(r.kept).contains("http://a/2.m3u8"), urls(r.kept).toString());
        check("还在的台一条没少", urls(r.kept).contains("http://a/1.m3u8")
                && urls(r.kept).contains("http://a/3.m3u8"), urls(r.kept).toString());
    }

    /** 上游新增一条 → 补进来，且带上来源标记 */
    private static void t03_upstreamAddedOne_isAdded() {
        List<Source> cur = list(owned("A台", "http://a/1.m3u8", LIST_A));
        List<Source> up = new ArrayList<>(Arrays.asList(
                new Source("A台", "http://a/1.m3u8", "央视"),
                new Source("新台", "http://a/new.m3u8", "卫视")));

        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("上游新增的台会补进来", r.added == 1 && r.removed == 0,
                "added=" + r.added + " removed=" + r.removed);
        check("新增的那条带上了来源标记（下次同步才能判断它该不该活）",
                r.kept.get(1).fromList(LIST_A), "from=" + r.kept.get(1).from);
    }

    /** ⚠️ 手加的源（from 为 null）绝不能被同步删掉 —— 这是最贵的错 */
    private static void t04_manualSourceNeverTouched() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                manual("我自己加的", "http://mine/1.m3u8"));
        // 上游清单里当然没有「我自己加的」
        List<Source> up = new ArrayList<>(Arrays.asList(
                new Source("A台", "http://a/1.m3u8", "央视")));

        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("自己手加的源不会被同步删掉",
                urls(r.kept).contains("http://mine/1.m3u8"), urls(r.kept).toString());
        check("同步没有把手加的算进删除数", r.removed == 0,
                "removed=" + r.removed);
    }

    /** ⚠️ 来自【别的】清单的源也不能被这份清单的同步删掉 */
    private static void t05_otherListSourceNeverTouched() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                owned("B清单的台", "http://b/1.m3u8", LIST_B));
        List<Source> up = new ArrayList<>(Arrays.asList(
                new Source("A台", "http://a/1.m3u8", "央视")));

        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("别家清单带来的源不会被这份清单的同步删掉",
                urls(r.kept).contains("http://b/1.m3u8"), urls(r.kept).toString());
        check("只删属于自己这份的", r.removed == 0, "removed=" + r.removed);
    }

    /** 1.10 及以前导入的（无 from）→ 第一次同步不删，但会补上 from 标记 */
    private static void t06_legacySourceNoFrom_isKeptAndTagged() {
        List<Source> cur = list(legacy("老台", "http://a/old.m3u8"));
        List<Source> up = new ArrayList<>(Arrays.asList(
                new Source("老台", "http://a/old.m3u8", "央视")));

        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("老版本导入的条目第一次同步不会被删（宁可先不删也不能误删真台）",
                r.removed == 0 && urls(r.kept).contains("http://a/old.m3u8"),
                "removed=" + r.removed + " kept=" + urls(r.kept));
        check("但会就地补上来源标记（下一次同步就能正确判断了）",
                r.kept.get(0).fromList(LIST_A), "from=" + r.kept.get(0).from);
    }

    /** 补上标记之后，第二次同步就会正确删除 —— 验证 t06 不是「永远不删」 */
    private static void t07_secondSyncAfterTagging_deletes() {
        List<Source> cur = list(legacy("老台", "http://a/old.m3u8"));
        List<Source> up1 = new ArrayList<>(Arrays.asList(
                new Source("老台", "http://a/old.m3u8", "央视")));
        SourceStore.SyncResult r1 = SourceStore.planSync(cur, up1, LIST_A, null);

        // 第二次：上游把「老台」下了
        List<Source> up2 = new ArrayList<Source>();
        SourceStore.SyncResult r2 = SourceStore.planSync(r1.kept, up2, LIST_A, null);
        check("补过标记后，下一次同步就会删掉（不是永远不删）",
                r2.removed == 1 && r2.kept.isEmpty(),
                "removed=" + r2.removed + " kept=" + urls(r2.kept));
    }

    /** 正在播的那条被删 → 要报出来，调用方才知道得换台 */
    private static void t08_playingRemovedIsReported() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                owned("B台", "http://a/2.m3u8", LIST_A));

        // 正在播的 A 台被上游删了
        SourceStore.SyncResult r1 = SourceStore.planSync(cur,
                new ArrayList<Source>(), LIST_A, "http://a/1.m3u8");
        check("正在播的那条被删了会报出来（调用方据此换台）",
                r1.playingRemoved == true, "playingRemoved=" + r1.playingRemoved);

        // 正在播的是 B 台，B 台还在 → 不报
        // ⚠️ 这里必须重新造一份 cur：planSync 的 markFrom 是【就地】补 from 的
        //    （它改的是 kept 里那个 Source 对象），复用同一批对象会串味 ——
        //    上一轮已经把 A 台标成"属于 LIST_A"了，于是这轮 A 台也会被当成该删的。
        List<Source> cur2 = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                owned("B台", "http://a/2.m3u8", LIST_A),
                owned("C台", "http://a/3.m3u8", LIST_A));
        // 正在播的是 C 台（还在），被删的是 A 台
        List<Source> keepA = new ArrayList<Source>();
        keepA.add(new Source("A台", "http://a/1.m3u8", "央视"));
        keepA.add(new Source("C台", "http://a/3.m3u8", "央视"));
        SourceStore.SyncResult r2 = SourceStore.planSync(cur2, keepA, LIST_A, "http://a/3.m3u8");
        check("被删的不是正在播的那条时不报（且确实只删了另一条）",
                r2.playingRemoved == false && r2.removed == 1
                && !urls(r2.kept).contains("http://a/2.m3u8")
                && urls(r2.kept).contains("http://a/3.m3u8"),
                "playingRemoved=" + r2.playingRemoved + " removed=" + r2.removed
                + " kept=" + urls(r2.kept));
    }

    /** 没有清单地址（退订之后）→ 什么都不做，绝不能顺手把列表清空 */
    private static void t09_emptyListUrlIsNoop() {
        List<Source> cur = list(owned("A台", "http://a/1.m3u8", LIST_A));
        SourceStore.SyncResult r = SourceStore.planSync(cur,
                new ArrayList<Source>(), null, null);
        SourceStore.SyncResult r2 = SourceStore.planSync(
                list(owned("A台", "http://a/1.m3u8", LIST_A)),
                new ArrayList<Source>(), "", null);
        check("没有清单地址时同步是空操作（不会把列表清空）",
                r.removed == 0 && r.kept.size() == 1
                && r2.removed == 0 && r2.kept.size() == 1,
                "null → removed=" + r.removed + " kept=" + urls(r.kept)
                + " / 空串 → removed=" + r2.removed + " kept=" + urls(r2.kept));
    }

    /** 退订：只删自己这份带来的 */
    private static void t10_unlistOnlyOwnSources() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                owned("A台2", "http://a/2.m3u8", LIST_A),
                owned("B清单的台", "http://b/1.m3u8", LIST_B),
                manual("我自己加的", "http://mine/1.m3u8"));
        List<Source> kept = planUnlist(cur, LIST_A);
        check("退订只删自己这份带来的两条",
                urls(kept).equals(Arrays.asList("http://b/1.m3u8", "http://mine/1.m3u8")),
                urls(kept).toString());
    }

    private static void t11_unlistKeepsManual() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                manual("我自己加的", "http://mine/1.m3u8"));
        List<Source> kept = planUnlist(cur, LIST_A);
        check("退订不动手加的源",
                urls(kept).equals(java.util.Collections.singletonList("http://mine/1.m3u8")),
                urls(kept).toString());
    }

    private static void t12_unlistOtherList() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                owned("B清单的台", "http://b/1.m3u8", LIST_B));
        List<Source> kept = planUnlist(cur, LIST_A);
        check("退订 A 清单不动 B 清单的源",
                urls(kept).equals(java.util.Collections.singletonList("http://b/1.m3u8")),
                urls(kept).toString());
    }

    /** 上游把台改名了（URL 变了）→ 从删除的角度看是「删一条+加一条」，符合预期 */
    private static void t13_renameLooksLikeDeletePlusAdd() {
        List<Source> cur = list(owned("CCTV-1", "http://a/old.m3u8", LIST_A));
        List<Source> up = new ArrayList<>(Arrays.asList(
                new Source("CCTV-1 综合", "http://a/new.m3u8", "央视")));

        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("上游改名 = 删一条加一条（老地址不会留下）",
                r.removed == 1 && r.added == 1 && r.kept.size() == 1
                && r.kept.get(0).url.equals("http://a/new.m3u8"),
                "removed=" + r.removed + " added=" + r.added + " kept=" + urls(r.kept));
    }

    /** 上游返回空清单 → 自己这份的全被删，手加的留下 */
    private static void t14_emptyUpstreamDeletesAllOwned() {
        List<Source> cur = list(
                owned("A台", "http://a/1.m3u8", LIST_A),
                manual("我自己加的", "http://mine/1.m3u8"));
        SourceStore.SyncResult r = SourceStore.planSync(cur,
                new ArrayList<Source>(), LIST_A, null);
        check("上游变空 → 自己这份全删光，手加的留下",
                r.removed == 1 && urls(r.kept).equals(
                        java.util.Collections.singletonList("http://mine/1.m3u8")),
                "removed=" + r.removed + " kept=" + urls(r.kept));
    }

    /** 请求头要跟着同步走（IPTV 大量源裸 m3u8 会 403） */
    private static void t15_headersSurviveSync() {
        List<Source> cur = list();
        Source up = new Source("带头的台", "http://a/h.m3u8", "央视");
        up.headers.put("User-Agent", "TestUA/1.0");

        SourceStore.SyncResult r = SourceStore.planSync(cur,
                new ArrayList<>(Arrays.asList(up)), LIST_A, null);
        check("新增的条目保留了请求头",
                r.kept.size() == 1 && "TestUA/1.0".equals(r.kept.get(0).headers.get("User-Agent")),
                r.kept.isEmpty() ? "(空)" : String.valueOf(r.kept.get(0).headers));
    }

    /** 2000 条上限仍然生效（同步是「增」的路径，也得封顶） */
    private static void t16_maxItemsRespected() {
        List<Source> cur = list();
        List<Source> up = new ArrayList<>();
        for (int i = 0; i < M3uParser.MAX_ITEMS + 50; i++) {
            up.add(new Source("台" + i, "http://a/" + i + ".m3u8", "央视"));
        }
        SourceStore.SyncResult r = SourceStore.planSync(cur, up, LIST_A, null);
        check("同步新增也受 2000 条上限约束",
                r.kept.size() == M3uParser.MAX_ITEMS,
                "kept=" + r.kept.size() + " 上限=" + M3uParser.MAX_ITEMS);
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------

    /** 退订的纯计算：复刻 SourceStore.unlist 的过滤规则（那边要 Context，跑不了） */
    private static List<Source> planUnlist(List<Source> cur, String listUrl) {
        List<Source> kept = new ArrayList<>();
        if (listUrl == null || listUrl.isEmpty()) { kept.addAll(cur); return kept; }
        for (Source s : cur) {
            if (s != null && s.fromList(listUrl)) continue;
            kept.add(s);
        }
        return kept;
    }

    private static Source owned(String name, String url, String from) {
        return new Source(name, url, "央视", from);
    }

    private static Source manual(String name, String url) {
        return new Source(name, url, "自建");            // from 留 null
    }

    /** 1.10 及以前存下来的：只有 n/u/g，没有 f */
    private static Source legacy(String name, String url) {
        return new Source(name, url, "央视");            // from 留 null（等价）
    }

    private static List<Source> list(Source... s) {
        return new ArrayList<>(Arrays.asList(s));
    }

    private static List<Source> plain(String n, String u) {
        return new ArrayList<>(Arrays.asList(new Source(n, u, "央视")));
    }

    private static List<String> urls(List<Source> l) {
        List<String> out = new ArrayList<>();
        for (Source s : l) out.add(s.url);
        return out;
    }

    private static void check(String name, boolean cond, String detail) {
        if (cond) { pass++; System.out.println("  ✓ " + name); }
        else { fail++; System.out.println("  ✗ " + name + (detail.isEmpty() ? "" : "   — " + detail)); }
    }
}
