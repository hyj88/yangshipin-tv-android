#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
央视频TV —— 生成图标资源。

本脚本负责两样东西，各走各的路：

  ① 桌面图标 ic_launcher —— **矢量**（res/drawable/ic_launcher.xml）
     minSdk 21（Android 5.0）起，AAPT2 不再把 VectorDrawable 烘成各密度 PNG，
     一张几百字节的 XML 就能顶掉原来 mdpi~xxxhdpi 五张位图，release 包直接小 9.9%。
     （minSdk 还是 19 的时候情况正相反：AAPT2 会烘出一整套 PNG，比手写位图还大，
      所以 1.4 才刻意只用位图。1.5 把 minSdk 提到 21 之后这套取舍整个反过来。）

  ② 电视横幅 tv_banner —— **位图**（drawable-{mdpi,hdpi,xhdpi,xxhdpi}/tv_banner.png）
     横幅是 Android TV 主屏的门面，各家 launcher 怎么取不一定（有的会按位图解码），
     矢量在这里赌不起，继续出真 PNG。

⚠️ 图标为什么要由脚本生成、而不是手写 XML 完事：
   位图时代留下的教训是「两处各写一遍迟早对不上」。现在虽然只剩矢量一份，
   但几何和颜色仍然只在这里定义一次，改设计改这里就行。

纯标准库实现（zlib + struct 手写 PNG），不依赖 PIL —— 本机没装 PIL。
4x 超采样 + 盒式滤波做抗锯齿。
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "yangshipin-tv", "app", "src", "main", "res")

SS = 4  # 超采样倍数

# --------------------------------------------------------------------------
# PNG 写出
# --------------------------------------------------------------------------


def write_png(path, w, h, rgba):
    """rgba: bytes/bytearray，长度 w*h*4，非预乘。"""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type 0 = None
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        out += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return out

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


# --------------------------------------------------------------------------
# 几何判定（都在设计坐标空间里做）
# --------------------------------------------------------------------------


def in_rrect(x, y, w, h, r):
    if x < 0 or y < 0 or x > w or y > h:
        return False
    cx = r if x < r else (w - r if x > w - r else x)
    cy = r if y < r else (h - r if y > h - r else y)
    if cx == x and cy == y:
        return True
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_circle(x, y, cx, cy, rad):
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad


def in_tri(x, y, pts):
    """pts 为 3 个 (x,y)；用边函数判断同侧。"""
    (x1, y1), (x2, y2), (x3, y3) = pts
    d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
    d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


# --------------------------------------------------------------------------
# 图层
# --------------------------------------------------------------------------


class Layer:
    """一块颜色来源：返回 (rgb, alpha) —— alpha 1=不透明。"""

    def color(self, x, y):
        raise NotImplementedError


class VGrad(Layer):
    """竖向渐变。"""

    def __init__(self, y0, y1, c0, c1):
        self.y0, self.y1, self.c0, self.c1 = y0, y1, c0, c1

    def color(self, x, y):
        t = min(1.0, max(0.0, (y - self.y0) / max(1e-6, self.y1 - self.y0)))
        return mix(self.c0, self.c1, t), 1.0


class CircleGrad(Layer):
    """圆形，带斜向渐变，做出一点体积感。"""

    def __init__(self, cx, cy, rad, c0, c1):
        self.cx, self.cy, self.rad, self.c0, self.c1 = cx, cy, rad, c0, c1

    def color(self, x, y):
        # 以左上到右下为轴
        t = ((x - (self.cx - self.rad)) + (y - (self.cy - self.rad))) / (4.0 * self.rad)
        t = min(1.0, max(0.0, t))
        return mix(self.c0, self.c1, t), 1.0


class Solid(Layer):
    def __init__(self, c):
        self.c = c

    def color(self, x, y):
        return self.c, 1.0


def render(path, W, H, design_w, design_h, stack, path_fn):
    """
    stack: [(判定函数(dx,dy)->bool, Layer)]，按顺序合成。
    path_fn(dx, dy) 把输出像素中心映射到设计坐标。
    """
    buf = bytearray(W * H * 4)
    inv = 1.0 / (SS * SS)
    for py in range(H):
        row = py * W * 4
        for px in range(W):
            ar = ag = ab = aa = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    dx, dy = path_fn(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)
                    r = g = b = 0.0
                    a = 0.0
                    for inside, layer in stack:
                        if inside(dx, dy):
                            c, la = layer.color(dx, dy)
                            # over 合成
                            r = c[0] * la + r * (1 - la)
                            g = c[1] * la + g * (1 - la)
                            b = c[2] * la + b * (1 - la)
                            a = la + a * (1 - la)
                    ar += r
                    ag += g
                    ab += b
                    aa += a
            o = row + px * 4
            buf[o] = int(round(min(255.0, ar * inv)))
            buf[o + 1] = int(round(min(255.0, ag * inv)))
            buf[o + 2] = int(round(min(255.0, ab * inv)))
            buf[o + 3] = int(round(min(255.0, aa * inv * 255)))
    return write_png(path, W, H, buf)


# --------------------------------------------------------------------------
# 图标：黑底圆角 + 红色播放圆 + 白色三角
# 与 drawable/ic_launcher.xml 同构（108 设计空间）
# --------------------------------------------------------------------------

ICON_BG = (0x10, 0x10, 0x12)      # #101012
ICON_RED = (0xE6, 0x00, 0x12)     # #E60012
WHITE = (0xFF, 0xFF, 0xFF)


def icon_stack():
    return [
        (lambda x, y: in_rrect(x, y, 108, 108, 24), Solid(ICON_BG)),
        (lambda x, y: in_circle(x, y, 54, 54, 38), Solid(ICON_RED)),
        (lambda x, y: in_tri(x, y, [(44, 36), (44, 72), (72, 54)]), Solid(WHITE)),
    ]


# ⚠️ 刻意【不用渐变】。PNG 侧当然能做出渐变，但矢量侧的 <gradient> 内联颜色
#    要 API 24 才支持，而最低那批设备是 5.0/5.1（API 21/22）—— 在那里会解析失败。
#    两边共用一组几何与颜色，所以统一用纯色。

# 矢量图标：108dp 设计空间，与 icon_stack() 的几何一一对应
ICON_VECTOR = """<?xml version="1.0" encoding="utf-8"?>
<!--
  央视频TV 桌面图标（矢量版）

  ⚠️ 这个文件 1.5 才回来的。1.4 之前 minSdk 是 19，minSdk<21 时 AAPT2 会把每个
     VectorDrawable **烘成一整套各密度的 PNG** 塞进包里，而且烘出来的比手写的
     位图更大更差（实测 release 124,461 → 只留位图 115,715），所以 1.4 把它删了。
     minSdk 提到 21 之后 AAPT2 不再烘，矢量图终于只占它自己这几百字节，
     于是一套 5 档 PNG（mdpi~xxxhdpi）全部删掉。详见 README §26。

  与位图版（tools/gen_icons.py）严格同构：同一个 108dp 设计空间、同一组颜色、
  同一个圆角 24 的黑底 + 半径 38 的红圆 + 白三角，换过去观感不该有差别。
-->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <!-- 圆角矩形底：#101012，圆角 24 -->
    <path
        android:fillColor="#101012"
        android:pathData="M24,0 L84,0 A24,24 0 0 1 108,24 L108,84 A24,24 0 0 1 84,108
                          L24,108 A24,24 0 0 1 0,84 L0,24 A24,24 0 0 1 24,0 Z" />

    <!-- 播放圆：#E60012，圆心 (54,54) 半径 38 -->
    <path
        android:fillColor="#E60012"
        android:pathData="M54,16 A38,38 0 1 1 54,92 A38,38 0 1 1 54,16 Z" />

    <!-- 三角：白，(44,36) (44,72) (72,54) -->
    <path
        android:fillColor="#FFFFFF"
        android:pathData="M44,36 L72,54 L44,72 Z" />
</vector>
"""


def gen_icon_vector():
    """写 drawable/ic_launcher.xml。几何与 icon_stack() 一致，改一处即可。"""
    path = os.path.join(RES, "drawable", "ic_launcher.xml")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(ICON_VECTOR)
    print("  drawable/          ic_launcher.xml   矢量   %6d B" % len(ICON_VECTOR.encode("utf-8")))


# --------------------------------------------------------------------------
# 电视横幅：与 drawable/tv_banner.xml 同构（320x180 设计空间）
# --------------------------------------------------------------------------

# 与 drawable/tv_banner.xml 同一组颜色
BANNER_BG = (0x0E, 0x0E, 0x10)    # #0E0E10
BAR_DIM = (0x2E, 0x2E, 0x34)
BAR_RED = (0xE6, 0x00, 0x12)

BARS = [
    (38, 128, BAR_DIM),
    (64, 104, BAR_RED),
    (90, 128, BAR_DIM),
    (116, 88, BAR_DIM),
    (142, 112, BAR_DIM),
]


def banner_stack():
    st = [
        (lambda x, y: 0 <= x <= 320 and 0 <= y <= 180, Solid(BANNER_BG)),
        (lambda x, y: in_circle(x, y, 72, 88, 42), Solid(ICON_RED)),
        (lambda x, y: in_tri(x, y, [(62, 70), (62, 106), (92, 88)]), Solid(WHITE)),
    ]
    for y, w, c in BARS:
        st.append((lambda x, y, w=w, yy=y: in_rrect(x - 148, y - yy, w, 16, 8), Solid(c)))
    return st


def gen_banner(density, px_w, px_h):
    path = os.path.join(RES, "drawable-%s" % density, "tv_banner.png")
    n = render(path, px_w, px_h, 320, 180, banner_stack(),
               lambda x, y: (x * 320.0 / px_w, y * 180.0 / px_h))
    print("  drawable-%-8s tv_banner.png    %4dx%-4d  %6d B" % (density, px_w, px_h, n))


def main():
    print("生成图标资源：")
    # 桌面图标：minSdk 21 起只出矢量，不再生成 mdpi~xxxhdpi 五档 PNG
    gen_icon_vector()
    # 电视横幅 320x180 dp（仍是位图，理由见文件头）
    # ⚠️ 这里以前写死只出 xhdpi=320x180 / xxhdpi=480x270，两个都是**错的**：
    #    横幅的设计空间是 320dp×180dp，按密度换算 xhdpi(2x) 应该是 640×360、
    #    xxhdpi(3x) 是 960×540。把 320×180 塞进 drawable-xhdpi，等于告诉系统
    #    「这是一张 160dp 宽的图」，在 xhdpi 电视上会被放大两倍 —— 横幅白白变糊。
    #    （是 legacy_capability_test 那条「tv_banner 各密度都有位图」报出来的，
    #      顺带才发现尺寸也标错了。）
    # ⚠️ 刻意【不】出 xxxhdpi：1280×720 那一张要 **11,936 字节**（比 AAPT2 烘的还大），
    #    而真会报告 xxxhdpi 的电视极少（4K 电视按 density 分类多数仍落在 xhdpi/xxhdpi）。
    #    到 xxhdpi 为止已经覆盖 720p~4K，xxxhdpi 由系统从 xxhdpi 放大 1.33 倍，
    #    纯色块图形放大这么一点看不出来。为它单独出一张 12KB 不值。
    for d, scale in (("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3)):
        gen_banner(d, int(round(320 * scale)), int(round(180 * scale)))
    print("完成。")


if __name__ == "__main__":
    main()
