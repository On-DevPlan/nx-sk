"""缺 PyMuPDF 时的可操作提示（被两个脚本共用）。

只报一句 "No module named" 对 agent 和新手都没用 —— 要说清**装什么、装到哪、
以及 Windows 上为什么装完还报错**。
"""
import sys

HINT = """\
缺少 PyMuPDF，这是本流程唯一的第三方依赖。

装进当前解释器（不要装全局）：

    python -m pip install pymupdf

WorkBuddy 托管环境用这条完整路径：

    ~/.workbuddy/binaries/python/envs/default/Scripts/python.exe -m pip install pymupdf

装完确认：

    python -c "import pymupdf; print(pymupdf.__version__)"

Windows 上如果装完仍报同样的错，多半是 `python` 指向了另一个解释器
（Microsoft Store 占位符或系统 Python）。改用上面那条完整路径的 python.exe 确认一遍。
"""


def require_pymupdf():
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        sys.exit(HINT)
