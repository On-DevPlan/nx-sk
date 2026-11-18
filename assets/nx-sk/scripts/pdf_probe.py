#!/usr/bin/env python3
"""PDF 探查：先看清版面，再决定怎么转。

    python pdf_probe.py <pdf>

回答三个问题：
  1. 这份 PDF 到底有没有图？（没有就别走图文 SOP）
  2. 图是大幅截图还是小图标装饰？（决定要不要抽图）
  3. 每页几张、页面尺寸统一吗？（判断排版特征）

用法上先跑这个、再跑 pdf_extract.py：盲目抽图是最常见的浪费。
"""
import os
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _deps import require_pymupdf

pymupdf = require_pymupdf()


def probe(path):
    doc = pymupdf.open(path)
    print(f"文件: {path}")
    print(f"页数: {doc.page_count}")

    sizes = Counter((round(p.rect.width), round(p.rect.height)) for p in doc)
    print(f"页面尺寸: {dict(sizes)}{'  (统一)' if len(sizes) == 1 else '  (不统一!)'}")

    textless = []
    img_by_page = {}
    dim_by_xref = {}
    total = 0

    for i, page in enumerate(doc):
        imgs = page.get_images(full=True)
        img_by_page[i] = len(imgs)
        total += len(imgs)
        if not page.get_text().strip():
            textless.append(i + 1)
        for im in imgs:
            xref = im[0]
            if xref in dim_by_xref:
                continue
            try:
                info = doc.extract_image(xref)
                dim_by_xref[xref] = (info["width"], info["height"])
            except Exception:
                dim_by_xref[xref] = (0, 0)

    print(f"内嵌图总数: {total}")
    if not textless:
        print("文字层: 每页都有文字（非扫描件）")
    else:
        shown = textless[:12]
        more = "" if len(textless) <= 12 else f" …共 {len(textless)} 页"
        print(f"!! 无文字层的页: {shown}{more}  ← 扫描件，需先 OCR")

    if total:
        print(f"图片尺寸分布（判断是截图还是图标）:")
        for (w, h), c in Counter(dim_by_xref.values()).most_common(10):
            kind = "截图" if w >= 600 and h >= 300 else ("小图/图标" if h < 200 else "中等")
            print(f"  {w}x{h:<6} × {c:<3}  [{kind}]")
        dist = Counter(img_by_page.values())
        print(f"每页图数分布: {dict(sorted(dist.items()))}")

    print()
    print("建议:")
    if total == 0:
        print("  没有图 → 直接抽文字建普通条目，不必走图文 SOP")
    elif not textless and total <= 5:
        print("  图很少 → 以文字为主，图作为补充")
    else:
        print("  图文混排 → 走完整图文 SOP")
        print("  下一步: python pdf_extract.py <pdf> --out /tmp/pdf-out")
        print("  然后**逐张看图**再决定留哪些（见 SKILL.md 第 2 步）")
    doc.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    probe(sys.argv[1])
