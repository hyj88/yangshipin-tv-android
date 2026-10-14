#!/usr/bin/env python3
"""裁剪放大设备截图（CSS px → 物理 px 自动换算）

用法: crop.py <输入.png> <输出.png> <x> <y> <w> <h> [scale]
坐标是 CSS px；物理倍率从 --dpr 读或默认 2.625（本模拟器）。
"""
import sys
from PIL import Image

def main():
    a = sys.argv[1:]
    dpr = 2.625
    if '--dpr' in a:
        i = a.index('--dpr'); dpr = float(a[i + 1]); del a[i:i + 2]
    src, out, x, y, w, h = a[0], a[1], float(a[2]), float(a[3]), float(a[4]), float(a[5])
    scale = float(a[6]) if len(a) > 6 else 1.0

    im = Image.open(src)
    box = (int(round(x * dpr)), int(round(y * dpr)),
           int(round((x + w) * dpr)), int(round((y + h) * dpr)))
    im = im.crop(box)
    if scale != 1.0:
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
    im.save(out)
    print(f'{out}  {im.width}x{im.height}  (源 {box})')

main()
