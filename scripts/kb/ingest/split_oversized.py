# scripts/kb/split_oversized.py
# 把三份 >10MB 的 oversized 主 PDF 用 pypdf 逐页重写拆分为小页 PDF（保留文本层），
# 绕过 pi-knowledge 的 oversized technical skip（阈值 <~11.48MB）。
# 输出：raw/_oversized_split/{guide_key}/part_{NNN}.pdf
# 与已归档的「无文本层残次拆分」区分：本脚本源 PDF 有完整文本层，pypdf 重写保留文本。
import os, sys
from pypdf import PdfReader, PdfWriter

BASE = "C:/WorkSpace/AgentProject/medical-agentic-rag/raw"
OUT = os.path.join(BASE, "_oversized_split")
PER = 10  # 每 10 页一份；单份约 <1MB，远低于 ~11MB 阈值

SRC = {
    "罕见病2025": "86个罕见病病种诊疗指南（2025年版）.pdf",
    "乳腺癌2025": "中国抗癌协会乳腺癌诊治指南与规范（2025年版）.pdf",
    "肝癌2026": "原发性肝癌诊疗指南（2026版）.pdf",
}

def split_one(key, fname):
    path = os.path.join(BASE, fname)
    if not os.path.exists(path):
        raise FileNotFoundError(f"源缺失: {path}")
    reader = PdfReader(path)
    n = len(reader.pages)
    d = os.path.join(OUT, key)
    os.makedirs(d, exist_ok=True)
    nparts = (n + PER - 1) // PER
    for i in range(0, n, PER):
        w = PdfWriter()
        for j in range(i, min(i + PER, n)):
            w.add_page(reader.pages[j])
        part = os.path.join(d, f"part_{i // PER + 1:03d}.pdf")
        with open(part, "wb") as f:
            w.write(f)
    print(f"  [{key}] {n} 页 -> {nparts} 份 (每 {PER} 页)")
    return nparts

def main():
    if os.path.exists(OUT):
        # 清理任何遗留（不应存在，已归档），保证干净重拆
        import shutil
        shutil.rmtree(OUT)
        print(f"清理旧 _oversized_split: {OUT}")
    os.makedirs(OUT, exist_ok=True)
    total = 0
    for key, fname in SRC.items():
        print(f"拆分 {fname} ...")
        total += split_one(key, fname)
    print(f"完成：共 {total} 份小页 PDF -> {OUT}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
