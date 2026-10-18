#!/usr/bin/env python3
"""PDF 抽取：文字 + 图片占位的 markdown，以及图片文件。

    python pdf_extract.py <pdf> --out /tmp/pdf-out          # 文字 + 占位 md
    python pdf_extract.py <pdf> --out /tmp/pdf-out --images-only --img-dir /tmp/imgs

## 为什么按 y 坐标排序，而不是按页码/抽取顺序

手册的版面是**文字与图交错**的：先一句说明，紧跟一张截图，再一句说明……
`page.get_images()` 给的顺序是 xref 顺序，`get_text()` 给的顺序是内部块序，
两者都不等于人读到的顺序。只有把文字块与图片矩形都换算成页面坐标、
按 y 排序拼起来，才能还原「这段话配这张图」。

实测（川农容器平台指南 p6）：文字块 y=342/381/413 说明堡垒机，
图 y=78–315 在其上方，y=445–702 在其下方 —— 按坐标排序才接得对。

## 为什么图片编号用 `页码_页内序号`

`006_1` 能直接回溯到「第 6 页第 1 张图」，挑图时对着编号说
「留 006_1、006_2、012_1」比描述图的内容更不容易出错，
也便于事后核对图片到底来自哪里。
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _deps import require_pymupdf

pymupdf = require_pymupdf()

# 低于这个尺寸的多半是页眉 logo / 分隔线 / 装饰，不该进 SOP
MIN_IMG_W = 200
MIN_IMG_H = 100


def page_items(page):
    """把一页里的文字块与图片矩形统一成 (y0, 类型, 载荷) 并按 y 排序。"""
    items = []
    for b in page.get_text("blocks"):
        if b[6] != 0:  # 0 = 文本块；1 = 图片块，避免重复
            continue
        text = b[4].strip()
        if text:
            items.append((b[1], "text", text))
    for im in page.get_images(full=True):
        xref = im[0]
        for r in page.get_image_rects(xref):
            if r.width < MIN_IMG_W or r.height < MIN_IMG_H:
                continue  # 装饰件
            items.append((r.y0, "image", (xref, r)))
    items.sort(key=lambda x: x[0])
    return items


def extract_text_md(doc):
    out = []
    seq = 0
    for i, page in enumerate(doc):
        items = page_items(page)
        if not items:
            continue
        out.append(f"\n<!-- ===== 第 {i + 1} 页 ===== -->\n")
        per_page = 0
        for _, kind, payload in items:
            if kind == "text":
                # 合并块内换行，段间留空行；避免 PDF 硬换行把一句话拆成多行
                for line in payload.splitlines():
                    line = line.strip()
                    if line:
                        out.append(line)
                        out.append("\n")
            else:
                per_page += 1
                seq += 1
                out.append(f"\n![p{i + 1}-{per_page}](IMG_{i + 1:03d}_{per_page})\n")
    return "".join(out)


def save_images(doc, img_dir, want_all=False):
    """导出图片，返回 {编号: 文件路径}。编号形如 006_1（第 6 页第 1 张）。"""
    os.makedirs(img_dir, exist_ok=True)
    saved = {}
    for i, page in enumerate(doc):
        per_page = 0
        for im in page.get_images(full=True):
            xref = im[0]
            rects = page.get_image_rects(xref)
            if not rects:
                continue
            r = rects[0]
            if not want_all and (r.width < MIN_IMG_W or r.height < MIN_IMG_H):
                continue  # 装饰件不落盘，免得后面翻目录时噪声太多
            per_page += 1
            name = f"{i + 1:03d}_{per_page}"
            try:
                info = doc.extract_image(xref)
            except Exception:
                continue
            path = os.path.join(img_dir, f"{name}.{info['ext']}")
            with open(path, "wb") as fh:
                fh.write(info["image"])
            saved[name] = path
    return saved


def main():
    ap = argparse.ArgumentParser(description="抽取 PDF 文字与图片为图文 markdown")
    ap.add_argument("pdf")
    ap.add_argument("--out", default=".", help="输出目录")
    ap.add_argument("--images-only", action="store_true", help="只导图片，不出 md")
    ap.add_argument("--img-dir", default=None, help="图片目录（默认 <out>/images）")
    ap.add_argument("--all-images", action="store_true", help="连装饰小图一起导出")
    args = ap.parse_args()

    doc = pymupdf.open(args.pdf)
    stem = os.path.splitext(os.path.basename(args.pdf))[0]
    os.makedirs(args.out, exist_ok=True)
    img_dir = args.img_dir or os.path.join(args.out, "images")

    saved = save_images(doc, img_dir, want_all=args.all_images)
    print(f"导出图片 {len(saved)} 张 → {img_dir}")

    if not args.images_only:
        md = extract_text_md(doc)
        md_path = os.path.join(args.out, f"{stem}.md")
        with open(md_path, "w", encoding="utf-8") as fh:
            fh.write(md)
        print(f"markdown → {md_path}")
        print()
        print("下一步:")
        print("  1. **逐张看图**（用图片查看器翻 images/ 目录），挑出 SOP 要用的")
        print("  2. 把选中的图上传: nx-sk file add --path images/<编号>.png --category other")
        print("  3. 把 md 里的 IMG_006_1 占位符换成上一步返回的附件 id")
        print("  4. 写入条目的 md 字段（见 SKILL.md 第 5 步）")
        if saved:
            print()
            print(f"可上传的图片编号: {', '.join(sorted(saved))}")

    doc.close()


if __name__ == "__main__":
    main()
