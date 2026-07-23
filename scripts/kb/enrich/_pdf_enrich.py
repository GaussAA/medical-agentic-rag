#!/usr/bin/env python3
# _pdf_enrich.py — PDF 文本质量检测、表格提取与 OCR 兜底
#
# 用法: python _pdf_enrich.py <pdf_path> [--tables] [--ocr] [--check-quality]
#
# 依赖:
#   pip install pdfplumber pdfminer.six
#   OCR 需额外安装: pip install pytesseract && tesseract-ocr + tesseract-ocr-chi-sim

import json, sys, os

def check_quality(text: str) -> dict:
    """检查 pdftotext 输出质量"""
    lines = text.strip().split("\n")
    total_chars = len(text)
    non_cjk = sum(1 for c in text if ord(c) < 0x4E00 or ord(c) > 0x9FFF)
    cjk_ratio = 1 - (non_cjk / max(total_chars, 1))
    # 中文 PDF 中 CJK 字符占比应 > 15%，否则可能为扫描件或提取失败
    return {
        "total_chars": total_chars,
        "non_cjk_chars": non_cjk,
        "cjk_ratio": round(cjk_ratio, 4),
        "line_count": len(lines),
        "low_quality": total_chars < 80 or cjk_ratio < 0.15,
    }

def extract_tables(pdf_path: str) -> list:
    """用 pdfplumber 提取表格，返回结构化数据"""
    import pdfplumber
    tables = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            page_tables = page.extract_tables()
            for tbl in page_tables:
                if not tbl or len(tbl) < 2:
                    continue
                # 清洗空单元格
                clean = []
                for row in tbl:
                    clean_row = [(c or "").strip() for c in row]
                    if any(c for c in clean_row):
                        clean.append(clean_row)
                if len(clean) >= 2:
                    # 转成 pipe 格式文本
                    text_lines = [" | ".join(row) for row in clean]
                    tables.append({
                        "page": page_idx + 1,
                        "rows": len(clean),
                        "cols": max(len(r) for r in clean),
                        "text": "\n".join(text_lines),
                    })
    return tables

def extract_text_fallback(pdf_path: str) -> str:
    """用 pdfminer 做文本提取兜底（pdftotext 不可用时的备用方案）"""
    from pdfminer.high_level import extract_text
    try:
        return extract_text(pdf_path)
    except Exception as e:
        return f"[pdfminer 错误: {e}]"

def try_ocr(pdf_path: str) -> str:
    """尝试 Tesseract OCR。依赖: pytesseract + tesseract-ocr"""
    try:
        import pytesseract
        from PIL import Image
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(pdf_path)
        texts = []
        for i in range(len(pdf)):
            page = pdf[i]
            bitmap = page.render(scale=2)
            pil_image = Image.frombytes("RGB", (bitmap.width, bitmap.height), bitmap.tobytes())
            text = pytesseract.image_to_string(pil_image, lang="chi_sim+eng")
            texts.append(text)
        pdf.close()
        return "\n\n".join(texts)
    except ImportError:
        return None  # pytesseract 未安装
    except Exception as e:
        return f"[OCR 错误: {e}]"

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: python _pdf_enrich.py <pdf_path> [--tables] [--ocr] [--check-quality]"}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    if not os.path.exists(pdf_path):
        print(json.dumps({"error": f"文件不存在: {pdf_path}"}))
        sys.exit(1)

    flags = set(sys.argv[2:])
    result = {"file": os.path.basename(pdf_path)}

    # 检查质量
    if "--check-quality" in flags:
        try:
            from pdfminer.high_level import extract_text
            text = extract_text(pdf_path)
            result["quality"] = check_quality(text)
            result["fallback_text"] = text[:2000]  # 前 2000 字符作参考
        except Exception as e:
            result["quality"] = {"low_quality": True, "error": str(e)}

    # 提取表格
    if "--tables" in flags:
        try:
            tables = extract_tables(pdf_path)
            result["tables"] = tables
            result["table_count"] = len(tables)
        except Exception as e:
            result["tables"] = []
            result["table_error"] = str(e)

    # OCR 兜底
    if "--ocr" in flags:
        ocr_text = try_ocr(pdf_path)
        if ocr_text is None:
            result["ocr"] = {"available": False, "message": "pytesseract 未安装, 跳过 OCR"}
        else:
            result["ocr"] = {"available": True, "text": ocr_text[:5000]}

    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
