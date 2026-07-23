#!/usr/bin/env python3
# _pdf_extract_images.py — 从 PDF 提取图片并保存
#
# 用法: python _pdf_extract_images.py <pdf_path> <output_dir>
# 输出: JSON — [{page, index, width, height, path, ext}, ...]
#
# 依赖: pip install PyMuPDF Pillow
#
# 设计要点:
#   · 对每张图片生成唯一文件名: {pdf_basename}_p{page}_i{index}.{ext}
#   · 过滤极小图片（<64x64，多为图标/装饰）
#   · 过滤极大图片比例（宽高比 > 10 的条状图）
#   · 输出 JSON 供 Node.js 消费（与 _pdf_enrich.py 同模式）

import json, sys, os
from pathlib import Path

MIN_SIZE = 64       # 最小边长（像素）
MAX_ASPECT = 10     # 最大宽高比（过滤条状装饰图）
MAX_IMAGES = 50     # 单 PDF 最多提取图片数

def extract_images(pdf_path: str, output_dir: str) -> list:
    import fitz  # PyMuPDF
    
    pdf_path = os.path.abspath(pdf_path)
    output_dir = os.path.abspath(output_dir)
    os.makedirs(output_dir, exist_ok=True)
    
    pdf_basename = os.path.splitext(os.path.basename(pdf_path))[0]
    # 清理文件名中的特殊字符
    pdf_basename = "".join(c if c.isalnum() or c in "-_" else "_" for c in pdf_basename)
    
    doc = fitz.open(pdf_path)
    images = []
    total = 0
    
    for page_num in range(len(doc)):
        page = doc[page_num]
        image_list = page.get_images(full=True)
        
        for img_idx, img in enumerate(image_list):
            if total >= MAX_IMAGES:
                break
            
            xref = img[0]
            base_image = doc.extract_image(xref)
            image_bytes = base_image["image"]
            ext = base_image["ext"]  # png, jpg, etc.
            width = base_image.get("width", 0)
            height = base_image.get("height", 0)
            
            # 过滤极小图片（图标、装饰线）
            if width < MIN_SIZE or height < MIN_SIZE:
                continue
            # 过滤条状装饰图
            if max(width, height) / max(min(width, height), 1) > MAX_ASPECT:
                continue
            # 过滤过小文件（< 2KB, 多半是单色块）
            if len(image_bytes) < 2048:
                continue
            
            # 生成文件名
            filename = f"{pdf_basename}_p{page_num + 1}_i{total + 1}.{ext}"
            filepath = os.path.join(output_dir, filename)
            
            with open(filepath, "wb") as f:
                f.write(image_bytes)
            
            images.append({
                "page": page_num + 1,
                "index": total + 1,
                "width": width,
                "height": height,
                "size_bytes": len(image_bytes),
                "ext": ext,
                "path": filepath,
                "filename": filename,
            })
            total += 1
    
    doc.close()
    return images


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "用法: python _pdf_extract_images.py <pdf_path> <output_dir>"}))
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    output_dir = sys.argv[2]
    
    if not os.path.isfile(pdf_path):
        print(json.dumps({"error": f"文件不存在: {pdf_path}"}))
        sys.exit(1)
    
    try:
        result = extract_images(pdf_path, output_dir)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
