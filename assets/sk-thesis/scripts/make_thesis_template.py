#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成《本科毕业论文（设计）》Word 模板（信息工程学院 · 设计开发类 · 2022 版规范）。

为什么用脚本而不是手搓 docx：
  格式规范是**一堆精确的数值**（页边距 cm、字号 pt、行距倍数、缩进字符、线宽磅）。
  手调只能保证"这一份"对，下次复用又得重来；写成脚本后，每一处数值都能对照规范
  逐条核对，改一处也只需要改一行。

规范来源：
  《信息工程学院本科毕业论文（设计）撰写规范（2022-11）》【设计开发类】
    - 本科开题报告、毕业论文格式和打印要求  p.8-12
    - 附件2 毕业论文（设计）模板              p.20-30

用法：
  python make_thesis_template.py --out ../templates/毕业论文模板-设计开发类.docx
"""

from __future__ import annotations

import argparse
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# —— 常量：全部来自规范原文，改之前先对一遍 PDF ——
CN_SONG = "宋体"
CN_HEI = "黑体"
CN_LI = "隶书"
CN_ZHONGSONG = "华文中宋"
LATIN = "Times New Roman"

SIZE_BODY = 12.0      # 小四
SIZE_H1 = 14.0        # 四号
SIZE_TITLE = 16.0     # 三号
SIZE_CAPTION = 10.5   # 五号
SIZE_NOTE = 9.0       # 小五

MARGIN_TOP = 2.5      # cm
MARGIN_BOTTOM = 2.0
MARGIN_LEFT = 2.5
MARGIN_RIGHT = 2.0
FOOTER_DIST = 1.5     # cm


# --------------------------------------------------------------------------
# 通用工具
# --------------------------------------------------------------------------
def _clear_theme_fonts(rfonts):
    """删掉主题字体属性 —— 否则 Word 会用主题字体盖掉我们显式设的宋体/黑体。"""
    for attr in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
        key = qn(f"w:{attr}")
        if rfonts.get(key) is not None:
            del rfonts.attrib[key]


def set_run_font(run, cn=CN_SONG, latin=LATIN, size=None, bold=False):
    """给一个 run 设置中西文字体与字号：中文走 eastAsia，西文/数字走 ascii。

    size=None 表示「不写死字号，跟样式走」——样式已经定好字号时不要覆盖，
    否则样式里的 10.5 / 16 / 30 会被统一压成 12pt。
    """
    run.font.name = latin
    if size is not None:
        run.font.size = Pt(size)
    run.font.bold = bold
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    _clear_theme_fonts(rfonts)
    rfonts.set(qn("w:ascii"), latin)
    rfonts.set(qn("w:hAnsi"), latin)
    rfonts.set(qn("w:eastAsia"), cn)


def set_style_font(style, cn=CN_SONG, latin=LATIN, size=SIZE_BODY, bold=False):
    style.font.name = latin
    style.font.size = Pt(size)
    style.font.bold = bold
    style.font.color.rgb = RGBColor(0, 0, 0)
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    _clear_theme_fonts(rfonts)
    rfonts.set(qn("w:ascii"), latin)
    rfonts.set(qn("w:hAnsi"), latin)
    rfonts.set(qn("w:eastAsia"), cn)


def mark_as_builtin_toc_style(style, name):
    """把样式伪装成 Word 内置的 toc 样式（去掉 customStyle、改小写名）。

    Word 更新目录域时会按内置 toc 1..3 重排条目；如果样式被标成 customStyle，
    Word 会另建内置样式并丢弃我们设的字体与缩进。
    """
    el = style.element
    if el.get(qn("w:customStyle")) is not None:
        del el.attrib[qn("w:customStyle")]
    name_el = el.find(qn("w:name"))
    if name_el is not None:
        name_el.set(qn("w:val"), name)
    # 内置样式一般带 uiPriority / semiHidden，补上更贴近 Word 自己的定义
    if el.find(qn("w:uiPriority")) is None:
        pri = OxmlElement("w:uiPriority")
        pri.set(qn("w:val"), "39")
        el.insert_element_before(
            pri, "w:semiHidden", "w:unhideWhenUsed", "w:qFormat", "w:locked",
            "w:personal", "w:personalCompose", "w:personalReply", "w:rsid",
            "w:pPr", "w:rPr", "w:tblPr", "w:trPr", "w:tcPr", "w:tblStylePr",
        )


def disable_auto_space(style):
    """关掉「中文与西文/数字自动加空隙」。

    规范要求「图1 名称」中图与序号之间**不空格**；Word 默认会在「图」和「1」之间
    自动插一点空隙，看起来就像多了一个空格。图表题必须关掉。
    """
    ppr = style.element.get_or_add_pPr()
    for tag in ("w:autoSpaceDE", "w:autoSpaceDN"):
        if ppr.find(qn(tag)) is None:
            el = OxmlElement(tag)
            el.set(qn("w:val"), "0")
            ppr.insert_element_before(
                el, "w:bidi", "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind",
            )


def set_indent_chars(style, first_line_chars=0, hanging_chars=0, left_chars=0):
    """按「字符」设缩进。

    Word 的 `w:firstLineChars` 才是真正的「首行缩进 N 字符」——只设 `w:firstLine`
    （twips）在换字号后会跑偏。两个都写：chars 优先，twips 作为兼容兜底。
    """
    ppr = style.element.get_or_add_pPr()
    ind = ppr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        ppr.append(ind)
    for attr in ("firstLine", "firstLineChars", "hanging", "hangingChars", "left", "leftChars"):
        key = qn(f"w:{attr}")
        if ind.get(key) is not None:
            del ind.attrib[key]
    if hanging_chars:
        ind.set(qn("w:hangingChars"), str(hanging_chars * 100))
        ind.set(qn("w:hanging"), str(int(hanging_chars * SIZE_BODY * 20)))
        ind.set(qn("w:leftChars"), str(left_chars * 100 if left_chars else hanging_chars * 100))
        ind.set(qn("w:left"), str(int((left_chars or hanging_chars) * SIZE_BODY * 20)))
    else:
        ind.set(qn("w:firstLineChars"), str(first_line_chars * 100))
        ind.set(qn("w:firstLine"), str(int(first_line_chars * SIZE_BODY * 20)))
        if left_chars:
            ind.set(qn("w:leftChars"), str(left_chars * 100))
            ind.set(qn("w:left"), str(int(left_chars * SIZE_BODY * 20)))


def set_para_indent(p, first_line_chars=0, hanging_chars=0, left_chars=0):
    ppr = p._p.get_or_add_pPr()
    ind = ppr.find(qn("w:ind"))
    if ind is None:
        ind = OxmlElement("w:ind")
        ppr.append(ind)
    for attr in ("firstLine", "firstLineChars", "hanging", "hangingChars", "left", "leftChars"):
        key = qn(f"w:{attr}")
        if ind.get(key) is not None:
            del ind.attrib[key]
    if hanging_chars:
        ind.set(qn("w:hangingChars"), str(hanging_chars * 100))
        ind.set(qn("w:hanging"), str(int(hanging_chars * SIZE_BODY * 20)))
        ind.set(qn("w:leftChars"), str((left_chars or hanging_chars) * 100))
        ind.set(qn("w:left"), str(int((left_chars or hanging_chars) * SIZE_BODY * 20)))
    else:
        ind.set(qn("w:firstLineChars"), str(first_line_chars * 100))
        ind.set(qn("w:firstLine"), str(int(first_line_chars * SIZE_BODY * 20)))


def style_para(style, *, align=None, line_spacing=1.5, before=0, after=0,
               keep_with_next=False, page_break_before=False):
    pf = style.paragraph_format
    if align is not None:
        pf.alignment = align
    pf.line_spacing = line_spacing
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.keep_with_next = keep_with_next
    pf.page_break_before = page_break_before
    pf.widow_control = True


def add_style(doc, name, *, cn=CN_SONG, latin=LATIN, size=SIZE_BODY, bold=False,
              align=None, indent=0, hanging=0, line_spacing=1.5,
              before=0, after=0, keep_with_next=False):
    styles = doc.styles
    try:
        st = styles[name]
    except KeyError:
        st = styles.add_style(name, 1)  # WD_STYLE_TYPE.PARAGRAPH == 1
    st.base_style = styles["Normal"]
    set_style_font(st, cn=cn, latin=latin, size=size, bold=bold)
    style_para(st, align=align, line_spacing=line_spacing, before=before, after=after,
               keep_with_next=keep_with_next)
    set_indent_chars(st, first_line_chars=indent, hanging_chars=hanging)
    return st


ANCHORS: dict[str, object] = {}


def mark(key, paragraph):
    """记下要挂批注的段落（run 在批注时必须已存在）。"""
    ANCHORS[key] = paragraph
    return paragraph


def para(doc, text="", style=None, *, cn=None, latin=None, size=None, bold=None,
         align=None, indent=None, hanging=None, line_spacing=None, before=None, after=None,
         color=None):
    p = doc.add_paragraph(style=style)
    if text:
        run = p.add_run(text)
        # 只有**显式**指定字体/字号时才写 run 级格式；否则交给样式，
        # 否则「封面校名 30pt」「图题 五号黑体」会被默认的 12pt 宋体盖掉。
        if cn or latin or size is not None or bold is not None:
            set_run_font(run, cn=cn or CN_SONG, latin=latin or LATIN, size=size,
                         bold=bool(bold))
        if color is not None:
            run.font.color.rgb = color
    if align is not None:
        p.alignment = align
    if indent is not None:
        set_para_indent(p, first_line_chars=indent)
    if hanging is not None:
        set_para_indent(p, hanging_chars=hanging)
    if line_spacing is not None:
        p.paragraph_format.line_spacing = line_spacing
    if before is not None:
        p.paragraph_format.space_before = Pt(before)
    if after is not None:
        p.paragraph_format.space_after = Pt(after)
    return p


def blank(doc, n=1):
    for _ in range(n):
        para(doc, "")


def page_break(doc):
    from docx.enum.text import WD_BREAK
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# --------------------------------------------------------------------------
# 复杂部件
# --------------------------------------------------------------------------
def add_field(paragraph, instr, placeholder=""):
    """插入一个 Word 域（PAGE / TOC）。"""
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    fld_begin.set(qn("w:dirty"), "true")
    run._r.append(fld_begin)

    run2 = paragraph.add_run()
    instr_el = OxmlElement("w:instrText")
    instr_el.set(qn("xml:space"), "preserve")
    instr_el.text = instr
    run2._r.append(instr_el)

    run3 = paragraph.add_run()
    fld_sep = OxmlElement("w:fldChar")
    fld_sep.set(qn("w:fldCharType"), "separate")
    run3._r.append(fld_sep)

    if placeholder:
        run4 = paragraph.add_run(placeholder)

    run5 = paragraph.add_run()
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run5._r.append(fld_end)

    return [run, run2, run3, run5]


def add_page_number_footer(section):
    """页脚：底端 1.5cm、居中、小五 Times New Roman、阿拉伯数字。"""
    section.footer_distance = Cm(FOOTER_DIST)
    footer = section.footer
    footer.is_linked_to_previous = False
    p = footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_para_indent(p, first_line_chars=0)
    p.paragraph_format.line_spacing = 1.0
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.space_after = Pt(0)
    add_field(p, " PAGE ", "1")
    for run in p.runs:
        set_run_font(run, cn=CN_SONG, latin=LATIN, size=SIZE_NOTE)


def restart_page_numbering(section, start=1):
    sect_pr = section._sectPr
    pg = sect_pr.find(qn("w:pgNumType"))
    if pg is None:
        pg = OxmlElement("w:pgNumType")
        sect_pr.insert_element_before(
            pg, "w:cols", "w:formProt", "w:vAlign", "w:noEndnote", "w:titlePg",
            "w:textDirection", "w:bidi", "w:rtlGutter", "w:docGrid",
            "w:printerSettings", "w:sectPrChange",
        )
    pg.set(qn("w:start"), str(start))
    pg.set(qn("w:fmt"), "decimal")


def set_table_no_borders(table):
    tbl = table._tbl
    tbl_pr = tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "none")
        el.set(qn("w:sz"), "0")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "auto")
        borders.append(el)
    # 按 OOXML schema 的位置插入，避免 Word 报「内容有问题」
    tbl_pr.insert_element_before(
        borders, "w:shd", "w:tblLayout", "w:tblCellMar", "w:tblLook",
        "w:tblCaption", "w:tblDescription",
    )


def cell_bottom_border(cell, sz_eighth_pt):
    """给单元格加下边框。sz 单位是 1/8 磅：1.5 磅 → 12，1 磅 → 8。"""
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.find(qn("w:tcBorders"))
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.insert_element_before(
            borders, "w:shd", "w:noWrap", "w:tcMar", "w:textDirection",
            "w:tcFitText", "w:vAlign", "w:hideMark",
        )
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), str(sz_eighth_pt))
    bottom.set(qn("w:space"), "0")
    bottom.set(qn("w:color"), "000000")
    borders.append(bottom)


def three_line_table(doc, header, rows, widths_cm, align_center=True):
    """三线表：无左右边线；上下底 1.5 磅，表头下 1 磅。"""
    table = doc.add_table(rows=1 + len(rows), cols=len(header))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_no_borders(table)

    for idx, width in enumerate(widths_cm):
        table.columns[idx].width = Cm(width)
        for cell in table.columns[idx].cells:
            cell.width = Cm(width)

    def fill(cell, text, bold=False):
        cell.text = ""
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER if align_center else WD_ALIGN_PARAGRAPH.LEFT
        p.paragraph_format.line_spacing = 1.5
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        set_para_indent(p, first_line_chars=0)
        run = p.add_run(text)
        set_run_font(run, cn=CN_SONG, latin=LATIN, size=SIZE_CAPTION, bold=bold)
        # 垂直居中
        tc_pr = cell._tc.get_or_add_tcPr()
        v_align = OxmlElement("w:vAlign")
        v_align.set(qn("w:val"), "center")
        tc_pr.append(v_align)

    for i, text in enumerate(header):
        fill(table.rows[0].cells[i], text, bold=False)

    for r, row in enumerate(rows, start=1):
        for c, text in enumerate(row):
            fill(table.rows[r].cells[c], text)

    # 表头下细实线（1 磅）
    for cell in table.rows[0].cells:
        cell_bottom_border(cell, 8)
    # 表格上下粗实线（1.5 磅）
    for cell in table.rows[0].cells:
        tc_pr = cell._tc.get_or_add_tcPr()
        borders = tc_pr.find(qn("w:tcBorders"))
        top = OxmlElement("w:top")
        top.set(qn("w:val"), "single")
        top.set(qn("w:sz"), "12")
        top.set(qn("w:space"), "0")
        top.set(qn("w:color"), "000000")
        borders.insert(0, top)
    for cell in table.rows[-1].cells:
        cell_bottom_border(cell, 12)

    # 表格尽量不跨页：行内禁止断行 + 除末行外与下行同页
    for r, row in enumerate(table.rows):
        tr_pr = row._tr.get_or_add_trPr()
        cant = OxmlElement("w:cantSplit")
        tr_pr.insert_element_before(cant, "w:trHeight", "w:tblHeader", "w:tblCellSpacing",
                                    "w:jc", "w:hidden")
        if r < len(table.rows) - 1:
            for cell in row.cells:
                for p in cell.paragraphs:
                    p.paragraph_format.keep_with_next = True

    return table


def add_toc(doc):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    set_para_indent(p, first_line_chars=0)
    p.paragraph_format.line_spacing = 1.5
    add_field(p, ' TOC \\o "1-3" \\h \\z \\u ',
              "目录将在打开文档后生成：右键此处 → 更新域 → 只更新页码/更新整个目录")
    for run in p.runs:
        set_run_font(run, cn=CN_SONG, latin=LATIN, size=SIZE_BODY)
    return p


def enable_update_fields(doc):
    """打开文档时提示更新域 —— 目录与页码才会自动刷新。"""
    settings = doc.settings.element
    if settings.find(qn("w:updateFields")) is None:
        el = OxmlElement("w:updateFields")
        el.set(qn("w:val"), "true")
        settings.insert_element_before(
            el, "w:hdrShapeDefaults", "w:footnotePr", "w:endnotePr", "w:compat",
            "w:docVars", "w:rsids", "w:mathPr", "w:themeFontLang", "w:clrSchemeMapping",
            "w:doNotIncludeSubdocsInStats", "w:doNotAutoCompressPictures",
        )


# --------------------------------------------------------------------------
# 样式表
# --------------------------------------------------------------------------
def build_styles(doc):
    styles = doc.styles

    # Normal = 正文：任何新段落默认就是规范要求的正文格式
    normal = styles["Normal"]
    set_style_font(normal, cn=CN_SONG, size=SIZE_BODY)
    style_para(normal, align=WD_ALIGN_PARAGRAPH.JUSTIFY, line_spacing=1.5)
    set_indent_chars(normal, first_line_chars=2)

    # 标题：用内置 Heading 1-3，目录域才认得出层级
    h1 = styles["Heading 1"]
    h1.base_style = normal
    set_style_font(h1, cn=CN_HEI, size=SIZE_H1, bold=False)
    style_para(h1, align=WD_ALIGN_PARAGRAPH.LEFT, line_spacing=1.5, keep_with_next=True)
    set_indent_chars(h1, first_line_chars=0)
    h1.paragraph_format.space_before = Pt(0)
    h1.paragraph_format.space_after = Pt(0)

    h2 = styles["Heading 2"]
    h2.base_style = normal
    set_style_font(h2, cn=CN_HEI, size=SIZE_BODY, bold=False)
    style_para(h2, align=WD_ALIGN_PARAGRAPH.LEFT, line_spacing=1.5, keep_with_next=True)
    set_indent_chars(h2, first_line_chars=0)

    h3 = styles["Heading 3"]
    h3.base_style = normal
    set_style_font(h3, cn=CN_SONG, size=SIZE_BODY, bold=False)
    style_para(h3, align=WD_ALIGN_PARAGRAPH.LEFT, line_spacing=1.5, keep_with_next=True)
    set_indent_chars(h3, first_line_chars=0)

    add_style(doc, "封面校名", cn=CN_LI, size=30, align=WD_ALIGN_PARAGRAPH.CENTER, indent=0)
    add_style(doc, "封面主标题", cn=CN_LI, size=28, align=WD_ALIGN_PARAGRAPH.CENTER, indent=0)
    add_style(doc, "封面副标题", cn=CN_HEI, size=16, align=WD_ALIGN_PARAGRAPH.CENTER, indent=0)
    add_style(doc, "封面信息", cn=CN_ZHONGSONG, size=15, align=WD_ALIGN_PARAGRAPH.LEFT, indent=0)
    add_style(doc, "目录标题", cn=CN_HEI, size=SIZE_TITLE, align=WD_ALIGN_PARAGRAPH.CENTER, indent=0)
    add_style(doc, "论文题目", cn=CN_HEI, size=SIZE_TITLE, align=WD_ALIGN_PARAGRAPH.CENTER, indent=0)
    add_style(doc, "摘要正文", cn=CN_SONG, size=SIZE_BODY, align=WD_ALIGN_PARAGRAPH.JUSTIFY, indent=0)
    add_style(doc, "英文题目", cn=CN_SONG, latin=LATIN, size=14, bold=True,
              align=WD_ALIGN_PARAGRAPH.CENTER, indent=0)
    add_style(doc, "英文信息", cn=CN_SONG, latin=LATIN, size=SIZE_BODY,
              align=WD_ALIGN_PARAGRAPH.CENTER, indent=0)
    add_style(doc, "英文摘要", cn=CN_SONG, latin=LATIN, size=SIZE_BODY,
              align=WD_ALIGN_PARAGRAPH.JUSTIFY, indent=0)
    add_style(doc, "图题", cn=CN_HEI, size=SIZE_CAPTION, align=WD_ALIGN_PARAGRAPH.CENTER,
              indent=0, keep_with_next=False)
    add_style(doc, "表题", cn=CN_HEI, size=SIZE_CAPTION, align=WD_ALIGN_PARAGRAPH.CENTER,
              indent=0, keep_with_next=True)
    disable_auto_space(styles["图题"])
    disable_auto_space(styles["表题"])
    add_style(doc, "表注", cn=CN_SONG, size=SIZE_NOTE, align=WD_ALIGN_PARAGRAPH.LEFT, indent=0)
    add_style(doc, "参考文献条目", cn=CN_SONG, size=SIZE_BODY, align=WD_ALIGN_PARAGRAPH.JUSTIFY,
              hanging=2)
    add_style(doc, "代码", cn=CN_SONG, size=SIZE_BODY, align=WD_ALIGN_PARAGRAPH.LEFT, indent=0)

    # 目录三级样式：一级黑体小四、二级宋体小四首行缩进 1 字符、三级首行缩进 2 字符。
    # 注意：必须去掉 w:customStyle 并把名字写成小写 "toc N" —— 否则 Word 更新目录域时
    # 会认为这是自定义样式，另建自己的内置 toc 样式，把这里的缩进与字体全部覆盖掉。
    toc1 = add_style(doc, "TOC 1", cn=CN_HEI, size=SIZE_BODY, indent=0)
    toc1.paragraph_format.tab_stops.add_tab_stop(Cm(16.5), 2, 1)  # RIGHT, DOTS
    toc2 = add_style(doc, "TOC 2", cn=CN_SONG, size=SIZE_BODY, indent=0)
    set_indent_chars(toc2, first_line_chars=1)
    toc2.paragraph_format.tab_stops.add_tab_stop(Cm(16.5), 2, 1)
    toc3 = add_style(doc, "TOC 3", cn=CN_SONG, size=SIZE_BODY, indent=0)
    set_indent_chars(toc3, first_line_chars=2)
    toc3.paragraph_format.tab_stops.add_tab_stop(Cm(16.5), 2, 1)
    for i, st in enumerate((toc1, toc2, toc3), start=1):
        mark_as_builtin_toc_style(st, f"toc {i}")


# --------------------------------------------------------------------------
# 页面
# --------------------------------------------------------------------------
def setup_page(section):
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(MARGIN_TOP)
    section.bottom_margin = Cm(MARGIN_BOTTOM)
    section.left_margin = Cm(MARGIN_LEFT)
    section.right_margin = Cm(MARGIN_RIGHT)
    section.header_distance = Cm(1.5)
    section.footer_distance = Cm(FOOTER_DIST)


# --------------------------------------------------------------------------
# 正文内容
# --------------------------------------------------------------------------
def build_cover(doc, meta):
    blank(doc, 5)
    para(doc, "四川农业大学", style="封面校名")
    blank(doc, 1)
    para(doc, "本科毕业论文（设计）", style="封面主标题")
    blank(doc, 1)
    para(doc, f"（{meta['year']}届）", style="封面副标题")
    blank(doc, 4)

    table = doc.add_table(rows=6, cols=4)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_no_borders(table)
    widths = [3.4, 5.4, 2.2, 3.8]
    for i, w in enumerate(widths):
        table.columns[i].width = Cm(w)
        for cell in table.columns[i].cells:
            cell.width = Cm(w)

    def cell_text(cell, text, align=WD_ALIGN_PARAGRAPH.LEFT):
        cell.text = ""
        p = cell.paragraphs[0]
        p.alignment = align
        p.paragraph_format.line_spacing = 1.5
        p.paragraph_format.space_before = Pt(0)
        p.paragraph_format.space_after = Pt(0)
        set_para_indent(p, first_line_chars=0)
        run = p.add_run(text)
        set_run_font(run, cn=CN_ZHONGSONG, size=15)
        tc_pr = cell._tc.get_or_add_tcPr()
        valign = OxmlElement("w:vAlign")
        valign.set(qn("w:val"), "center")
        tc_pr.append(valign)
        return p

    rows = [
        ("题    目：", meta["title"], None, None),
        ("学    院：", meta["college"], None, None),
        ("专    业：", meta["major"], None, None),
        ("学生姓名：", meta["student"], "学号：", meta["studentId"]),
        ("导    师：", meta["advisor"], "职称：", meta["advisorTitle"]),
        ("完成日期：", f"{meta['year']} 年      月      日", None, None),
    ]
    for r, (l1, v1, l2, v2) in enumerate(rows):
        cell_text(table.rows[r].cells[0], l1)
        if l2 is None:
            merged = table.rows[r].cells[1].merge(table.rows[r].cells[3])
            p_done = cell_text(merged, v1)
            cell_bottom_border(merged, 6)
            if r == 0:
                mark("cover_title", p_done)
            if r == 5:
                mark("cover_date", p_done)
        else:
            cell_text(table.rows[r].cells[1], v1)
            cell_text(table.rows[r].cells[2], l2)
            cell_text(table.rows[r].cells[3], v2)
            cell_bottom_border(table.rows[r].cells[1], 6)
            cell_bottom_border(table.rows[r].cells[3], 6)

    # 让每行有高度，像正式封面
    for row in table.rows:
        tr_pr = row._tr.get_or_add_trPr()
        height = OxmlElement("w:trHeight")
        height.set(qn("w:val"), "680")
        tr_pr.append(height)


def build_toc(doc):
    page_break(doc)
    para(doc, "目  录", style="目录标题")
    blank(doc, 1)
    mark("toc", add_toc(doc))


def build_title_page(doc, meta):
    mark("title_page", para(doc, meta["title"], style="论文题目"))
    blank(doc, 1)
    para(doc, f"{meta['major']}　{meta['student']}", style="英文信息")
    para(doc, f"导师：{meta['advisor']}", style="英文信息")
    blank(doc, 1)

    p = para(doc, "", style="摘要正文")
    r1 = p.add_run("摘要：")
    set_run_font(r1, cn=CN_SONG, size=SIZE_BODY)
    r2 = p.add_run(
        "【目的】××××××；【方法】××××××；【结果】××××××；【结论】××××××。"
        "（此处写 250–300 字，一段到底，不分段；不出现公式与图表，不标引用编号。）"
    )
    set_run_font(r2, cn=CN_SONG, size=SIZE_BODY)
    mark("abstract", p)

    p = para(doc, "", style="摘要正文")
    r1 = p.add_run("关键词：")
    set_run_font(r1, cn=CN_SONG, size=SIZE_BODY)
    r2 = p.add_run("知识管理；多智能体协作；检索增强生成；多端协同")
    set_run_font(r2, cn=CN_SONG, size=SIZE_BODY)
    mark("keywords", p)

    blank(doc, 1)

    mark("title_en", para(doc, meta["titleEn"], style="英文题目"))
    blank(doc, 1)
    para(doc, f"{meta['majorEn']}　{meta['studentEn']}", style="英文信息")
    para(doc, f"Supervisor: {meta['advisorEn']}", style="英文信息")
    blank(doc, 1)

    p = para(doc, "", style="英文摘要")
    r1 = p.add_run("Abstract: ")
    set_run_font(r1, cn=CN_SONG, latin=LATIN, size=SIZE_BODY, bold=True)
    r2 = p.add_run(
        "[Objective] ××××××; [Method] ××××××; [Result] ××××××; [Conclusion] ××××××. "
        "(Write 250–300 words in one paragraph, consistent with the Chinese abstract.)"
    )
    set_run_font(r2, cn=CN_SONG, latin=LATIN, size=SIZE_BODY)
    mark("abstract_en", p)

    p = para(doc, "", style="英文摘要")
    r1 = p.add_run("Key words: ")
    set_run_font(r1, cn=CN_SONG, latin=LATIN, size=SIZE_BODY, bold=True)
    r2 = p.add_run("knowledge management; multi-agent collaboration; retrieval-augmented generation; multi-terminal collaboration")
    set_run_font(r2, cn=CN_SONG, latin=LATIN, size=SIZE_BODY)
    mark("keywords_en", p)


def build_body(doc):
    page_break(doc)

    # 1 绪论
    mark("h1", h1(doc, "1", "绪论"))
    mark("h2", h2(doc, "1.1", "研究背景与意义"))
    mark("body", body(doc, "随着大语言模型与检索增强生成（retrieval-augmented generation，RAG）技术的成熟，"
              "个人与团队的知识管理正从手工结构化转向对话式交互[1]。现有工具多停留在"
              "「只读检索」，缺少可控、可追溯的知识写入链路，用户在检索、整理与更新之间反复切换。"
              "××××××。"))
    body(doc, "本课题拟构建一个多端协同的知识记录系统，把「检索—写入—确认」收敛到同一条对话链路中，"
              "以降低知识沉淀的成本。××××××。")

    h2(doc, "1.2", "国内外研究现状")
    mark("h3", h3(doc, "1.2.1", "知识管理系统研究现状"))
    body(doc, "现有知识管理系统大致可分为文档型、图谱型与对话型三类，各自的取舍在于结构化程度"
              "与录入成本之间的平衡[2]。××××××。")
    h3(doc, "1.2.2", "多智能体协作与 RAG 研究现状")
    body(doc, "多智能体协作把复杂任务拆解为可独立优化的子任务，并由编排器统一调度[3]；"
              "RAG 则通过检索证据片段约束生成内容，缓解模型幻觉。二者结合的关键在于写入前的风险控制。"
              "××××××。")

    h2(doc, "1.3", "主要研究内容与论文结构")
    body(doc, "本文共分为 6 章：第 1 章介绍研究背景与意义；第 2 章说明相关方法与技术；"
              "第 3 章给出需求分析与总体设计；第 4 章阐述重点模块的设计与实现；"
              "第 5 章进行系统测试与结果分析；第 6 章总结全文并展望后续工作。")

    # 2 相关方法与技术
    blank(doc, 1)
    h1(doc, "2", "相关方法与技术")
    h2(doc, "2.1", "检索增强生成")
    body(doc, "RAG 将「检索」与「生成」解耦：先按查询召回证据片段，再把片段作为上下文交给生成模型。"
              "本系统采用 BM25 与向量检索的混合方案，以兼顾关键词精确匹配与语义召回。××××××。")
    h2(doc, "2.2", "多智能体协作与编排")
    body(doc, "系统把「理解—检索—生成补丁—风险控制」拆成若干专职智能体，由编排器按状态机推进。"
              "涉及写入、覆盖、删除等高风险动作时引入人工确认（human-in-the-loop）。××××××。")
    h2(doc, "2.3", "多端协同技术")
    body(doc, "Web 端承担复杂编辑，浏览器插件负责网页内的快速采集，移动端用于随时查阅。"
              "三端通过统一的 HTTP 接口与同一份鉴权体系协同。××××××。")

    # 3 需求分析与总体设计
    blank(doc, 1)
    h1(doc, "3", "系统需求分析与总体设计")
    h2(doc, "3.1", "需求分析")
    body(doc, "通过对目标用户的访谈与竞品分析，系统需满足以下四类需求：")
    mark("list", body(doc, "（1）对话式检索：用户以自然语言提问，系统返回带出处的答案。"))
    body(doc, "（2）受控写入：新增、修改、归档等动作需在关键节点二次确认。")
    body(doc, "（3）多端一致：Web、浏览器插件与移动端共享同一份知识库。")
    body(doc, "（4）可追溯：每次变更保留版本与操作记录，支持回滚。")

    h2(doc, "3.2", "总体架构设计")
    body(doc, "系统采用前后端分离架构，整体分为接入层、编排层、检索层与存储层，如图1所示。")
    # 图与正文上下各空一行；图片段落与图题用 keep_with_next 绑在一起，避免图题被拆页
    blank(doc, 1)
    ph = mark("figure", body(doc, "［在此插入插图：嵌入型、居中、首行不缩进；图与正文上下各空一行］",
                             style="图题", color=RGBColor(0x80, 0x80, 0x80)))
    ph.paragraph_format.keep_with_next = True
    mark("figure_caption", para(doc, "图1 系统总体架构图", style="图题"))
    blank(doc, 1)

    body(doc, "接入层负责多端协议适配；编排层由智能体与状态机组成；检索层提供混合召回；"
              "存储层使用 PostgreSQL 与 pgvector 保存知识条目与向量索引。")

    h2(doc, "3.3", "数据库设计")
    body(doc, "知识条目表用于保存正文、元信息与版本号，主要字段如表1所示。")
    blank(doc, 1)
    mark("table_caption", para(doc, "表1 知识条目表结构", style="表题"))
    three_line_table(
        doc,
        ["字段名", "类型", "说明"],
        [
            ["id", "uuid", "条目主键"],
            ["title", "varchar(200)", "条目标题"],
            ["content", "text", "正文（Markdown）"],
            ["version", "integer", "版本号，写入时自增"],
            ["updated_at", "timestamptz", "最后更新时间"],
        ],
        [4.2, 4.6, 6.2],
    )
    mark("table_note", para(doc, "注：content 字段保存原始 Markdown，渲染在前端完成。", style="表注"))
    blank(doc, 1)

    # 4 详细设计与实现
    blank(doc, 1)
    h1(doc, "4", "重点模块详细设计与实现")
    h2(doc, "4.1", "对话意图识别模块")
    body(doc, "意图识别模块把用户输入映射为「查询 / 新增 / 修改 / 归档」四类操作。"
              "为保证可解释性，分类结果附带置信度，低于阈值时转为澄清提问。××××××。")
    h2(doc, "4.2", "知识检索与写入模块")
    body(doc, "检索模块先做查询改写，再并行执行关键词与向量召回，最后按倒数排名融合（RRF）重排。"
              "写入模块生成补丁而非整篇覆盖，补丁经风险检查后进入确认队列。××××××。")
    h2(doc, "4.3", "关键实现代码")
    body(doc, "请求处理的核心流程如下，意图识别与检索通过接口解耦，便于替换实现：")
    code = (
        "func (s *Service) HandleQuery(ctx context.Context, q string) (*Reply, error) {\n"
        "    intent := s.intent.Recognize(q)          // 意图识别\n"
        "    if intent == IntentWrite {               // 写入需二次确认\n"
        "        return s.confirm.Ask(ctx, q)\n"
        "    }\n"
        "    hits := s.retriever.Search(q, 8)         // 混合检索：BM25 + 向量\n"
        "    return s.generator.Reply(ctx, q, hits)   // 带出处的回答\n"
        "}"
    )
    p = para(doc, "", style="代码")
    for i, line in enumerate(code.split("\n")):
        if i:
            p.add_run().add_break()
        run = p.add_run(line)
        set_run_font(run, cn=CN_SONG, latin=LATIN, size=SIZE_BODY)
    mark("code", p)

    # 5 系统测试
    blank(doc, 1)
    h1(doc, "5", "系统测试与结果分析")
    h2(doc, "5.1", "测试环境与测试方法")
    body(doc, "测试在 Windows 11 + Chrome 浏览器环境下进行，服务端部署于 4 核 8 GB 的云主机。"
              "功能测试采用黑盒用例，性能测试使用 Locust 施压，意图识别单独构建人工标注测试集。")
    h2(doc, "5.2", "测试结果与分析")
    body(doc, "意图识别在 600 条标注样本上的结果如表2所示，整体准确率为 88.5%，"
              "其中「归档」类因样本较少略低。")
    blank(doc, 1)
    para(doc, "表2 意图识别测试结果", style="表题")
    three_line_table(
        doc,
        ["意图类别", "样本数", "准确率"],
        [
            ["查询", "240", "92.1%"],
            ["新增", "180", "88.9%"],
            ["修改", "120", "86.7%"],
            ["归档", "60", "81.7%"],
        ],
        [5.0, 4.0, 4.0],
    )
    blank(doc, 1)
    body(doc, "检索侧以 Recall@8 与平均响应时延衡量：混合检索的 Recall@8 为 0.91，"
              "较单一向量检索提升 6 个百分点，平均时延增加 38 ms，仍在可接受范围内。××××××。")

    # 6 结论
    blank(doc, 1)
    h1(doc, "6", "结论")
    body(doc, "本文围绕对话驱动的知识记录，完成了需求分析、总体设计、关键模块实现与系统测试。"
              "系统把检索与受控写入收敛到同一条链路，并在多端之间共享同一份知识库。××××××。")
    body(doc, "受时间与数据规模限制，本文的评测集仍偏小，跨领域迁移效果有待验证；"
              "后续将扩充标注样本，并探索更细粒度的权限与审计机制。××××××。")


def h1(doc, num, title):
    return doc.add_paragraph(f"{num} {title}", style="Heading 1")


def h2(doc, num, title):
    return doc.add_paragraph(f"{num} {title}", style="Heading 2")


def h3(doc, num, title):
    return doc.add_paragraph(f"{num} {title}", style="Heading 3")


def body(doc, text, style="Normal", color=None):
    return para(doc, text, style=style, color=color)


def build_references(doc):
    page_break(doc)
    mark("refs_heading", doc.add_paragraph("参考文献", style="Heading 1"))
    refs = [
        "[1] 张三, 李四, 王五, 等. 融合多智能体协作的知识管理方法[J]. 计算机应用研究, 2023, 40(5):1-6.",
        "[2] 李华. 基于检索增强生成的智能问答系统研究[D]. 成都: 四川农业大学, 2022.",
        "[3] BROWN T, MANN B, RYDER N, et al. Language models are few-shot learners[C]// "
        "Advances in Neural Information Processing Systems. 2020: 1877-1901.",
    ]
    for i, ref in enumerate(refs):
        p = para(doc, ref, style="参考文献条目")
        if i == 0:
            mark("ref_item", p)


def build_thanks(doc):
    page_break(doc)
    # 致谢要进目录，所以用 Heading 1（保持大纲级别），只把对齐改成居中
    p = doc.add_paragraph("致谢", style="Heading 1")
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_after = Pt(0)
    mark("thanks", p)
    body(doc, "谨向在论文完成过程中给予指导与帮助的老师、同学与家人表示感谢。××××××。"
              "（致谢 200 字以上，按正文格式排版。）")


def build_appendix(doc):
    page_break(doc)
    mark("appendix", doc.add_paragraph("附录", style="Heading 1"))
    body(doc, "（1）核心接口定义")
    p = para(doc, "", style="代码")
    lines = [
        "POST /api/chat      对话：返回答案与引用片段",
        "POST /api/confirm   确认写入补丁",
        "GET  /api/search    混合检索（BM25 + 向量）",
    ]
    for i, line in enumerate(lines):
        if i:
            p.add_run().add_break()
        run = p.add_run(line)
        set_run_font(run, cn=CN_SONG, latin=LATIN, size=SIZE_BODY)


# --------------------------------------------------------------------------
# 批注（提交前可在 Word 里「审阅 → 删除所有批注」）
# --------------------------------------------------------------------------
COMMENTS = {
    "cover_title": "题目原则上不超过 20 字。本题目按字符计 27 个，已超限；建议压缩为"
                   "「融合多智能体与RAG的多端知识记录系统」（19 字）或加副标题，定稿前与导师确认。",
    "cover_date": "完成日期应晚于答辩委员会日期；（20XX届）填毕业年份，不是入学年份。",
    "toc": "目录只提取到三级标题；本页不编页码。改过标题后右键此处 → 更新域；提交前务必"
           "「更新整个目录」，否则页码与正文对不上。",
    "title_page": "题目：黑体三号、居中。内页封面、目录、本页都不编页码；从本页起编阿拉伯数字"
                  " 1、2、3…（页脚底端 1.5cm、居中、小五 Times New Roman）。全文一般不少于"
                  " 8000 字、25 页以上。",
    "abstract": "摘要 250–300 字，不分段；按【目的】【方法】【结果】【结论】组织；"
                "不出现公式与图表，不标引用编号。",
    "keywords": "关键词 3–5 个，能覆盖论文主要内容；按外延由大到小排列；分号分隔。",
    "title_en": "英文题目与中文对应；实词首字母大写（介词、连词除外）；Times New Roman 四号加粗。",
    "abstract_en": "Abstract 与中文摘要对应；标签 Abstract 加粗，正文不加粗。",
    "keywords_en": "Key words 与中文关键词一一对应，分号分隔。",
    "h1": "一级标题：黑体（西文 TNR）四号，不加粗；顶格写序号，空一格写标题；单独占行，"
          "末尾不加标点；标题前空一行。",
    "h2": "二级标题：黑体（西文 TNR）小四，不加粗；顶格；单独占行，末尾不加标点。",
    "h3": "三级标题：宋体（西文 TNR）小四，不加粗；顶格。",
    "body": "正文：宋体小四（西文与数字 TNR 小四）；1.5 倍行距；段前段后 0；首行缩进 2 字符；"
            "标准字距。",
    "list": "四级标题不单独占行：用（1）（2）接排，按正文格式（首行缩进 2 字符）。"
            "建议手打编号——Word 自动编号会带悬挂缩进，换行后的缩进与规范不符。",
    "figure": "插图放在正文提及之后；版式嵌入型、居中、首行不缩进；白底黑字黑线，不加底纹与网格；"
              "四周不要大片空白；图与正文上下各空一行。",
    "figure_caption": "图题在图下方：黑体五号（西文 TNR），居中；写「图1 名称」——图与序号之间"
                      "不空格，序号与名称之间空一格；全文连续编号，不要写成 图1-1 或 图1.1。",
    "table_caption": "表题在表上方：黑体五号，居中，「表1 名称」。表格用三线表：无左右边线；"
                     "上下底 1.5 磅粗实线，表头下 1 磅细实线；表内五号（中文宋体、西文 TNR）；"
                     "尽量不跨页。",
    "table_note": "有表注时写在表底线下方左侧，宋体小五（西文 TNR）。",
    "code": "代码不超过 3/4 页，只保留难以用文字描述的核心代码；按正文字体字号（宋体小四）；"
            "缩进 2 或 4 空格，同级起止同列；行内注释对齐；讲解以思想与流程为主。"
            "大段完整代码放附录。",
    "refs_heading": "参考文献另起一页，标题黑体四号、顶格、不加数字序号。",
    "ref_item": "小四，1.5 倍行距，悬挂缩进 2 字符；标点用英文半角、后空一格；每条以实心点结束。"
                "按 GB/T 7714-2015 著录；≥15 篇，其中外文 ≥2 篇；正文引用处右上角上标 [X]，"
                "按出现先后编号，同一文献只用一个编号。",
    "thanks": "致谢另起一页，「致谢」黑体四号、居中；内容按正文格式，200 字以上。",
    "appendix": "附录另起一页，内容格式参照正文；原始数据、数据库表结构、大段代码放这里。",
}


def add_comments(doc):
    for key, text in COMMENTS.items():
        p = ANCHORS.get(key)
        if p is not None and getattr(p, "runs", None):
            doc.add_comment(p.runs, text=text, author="格式要求", initials="FMT")


def build(out_path: Path):
    meta = {
        "title": "融合多智能体协作与RAG检索的多端智能知识记录系统研发",
        "titleEn": "Development of a Multi-Terminal Intelligent Knowledge Recording System "
                   "Integrating Multi-Agent Collaboration and RAG Retrieval",
        "college": "信息工程学院",
        "major": "物联网工程",
        "majorEn": "Internet of Things Engineering",
        "student": "赵刘学",
        "studentEn": "ZHAO Liu-xue",
        "studentId": "202308648",
        "advisor": "刘剑",
        "advisorEn": "LIU Jian",
        "advisorTitle": "讲师",
        "year": "2027",
    }

    doc = Document()
    build_styles(doc)
    setup_page(doc.sections[0])
    enable_update_fields(doc)

    doc.core_properties.title = "本科毕业论文（设计）模板（设计开发类）"
    doc.core_properties.subject = "信息工程学院 2022 版撰写规范"
    doc.core_properties.author = "nx-sk"

    # —— 第 1 节：内页封面 + 目录（不编页码）——
    build_cover(doc, meta)
    build_toc(doc)

    # —— 第 2 节：标题页起编页码，从 1 开始 ——
    section2 = doc.add_section(WD_SECTION.NEW_PAGE)
    setup_page(section2)
    restart_page_numbering(section2, 1)
    add_page_number_footer(section2)
    # 第 1 节页脚保持空白（不链接到第 2 节）
    section1 = doc.sections[0]
    section1.footer.is_linked_to_previous = False
    section1.footer_distance = Cm(FOOTER_DIST)

    build_title_page(doc, meta)
    build_body(doc)
    build_references(doc)
    build_thanks(doc)
    build_appendix(doc)

    add_comments(doc)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(out_path))
    return out_path


def main():
    parser = argparse.ArgumentParser(description="生成本科毕业论文模板 docx")
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent.parent /
                                             "templates" / "毕业论文模板-设计开发类.docx"))
    args = parser.parse_args()
    path = build(Path(args.out))
    print(f"已生成: {path}")


if __name__ == "__main__":
    main()
