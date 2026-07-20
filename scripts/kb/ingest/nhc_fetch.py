#!/usr/bin/env python3
# nhc_fetch.py —— NHC 卫健委指南 PDF 直链下载器（KB 偏科补录专用）
#
# 核心约束（血泪教训，详见 skills/nhc-medical-pdf-crawl）:
#   1. NHC 的 412 WAF 只拦 HTML 通知页，不拦 /files/xxx.pdf 直链；
#      发现页用 WebFetch（其 fetcher 不受 412 影响）抽直链，本脚本只直下二进制。
#   2. 中文名 URL 已编码的直链可直接 urllib 下载；勿手抄 %xx 串。
#   3. 保存名含 Windows 非法字符（尤其 `/`，如 WS/T 477）须清洗为 `-`。
#   4. 临时文件与目标同盘（本仓在 C:，故 tmp 也落 C:），避免跨盘 os.replace 失败。
#   5. 沙箱 safe-delete 拦截 os.remove；重复件不删，移 _discarded/ 暂存（本脚本仅下载不删）。
#
# 用法:
#   python3 nhc_fetch.py <outdir> <url> <save_name>
#   python3 nhc_fetch.py <outdir> <links.json>      # links.json: [{"url","name","dept","src"}, ...]
#
# 退出码: 0=全成功(含去重跳过) / 1=存在失败
import os, sys, json, time, hashlib, urllib.request, urllib.error


UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

ILLEGAL = '/\\:*?"<>|'


def sanitize(name: str) -> str:
    for ch in ILLEGAL:
        name = name.replace(ch, "-")
    return name.strip()


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: str, referer: str = "", retries: int = 3) -> int:
    headers = {"User-Agent": UA}
    if referer:
        headers["Referer"] = referer
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=120) as r:
                if r.status != 200:
                    raise urllib.error.HTTPError(url, r.status, "", None, None)
                data = r.read()
            if len(data) < 1024:
                raise ValueError(f"文件过小 {len(data)}B（疑似非 PDF）")
            with open(dest, "wb") as f:
                f.write(data)
            return len(data)
        except Exception as e:  # 显式捕获，禁止静默失败
            last = e
            print(f"  [重试{attempt}] {type(e).__name__}: {e}", file=sys.stderr)
            time.sleep(2 * attempt)
    raise RuntimeError(f"下载失败 {url} -> {last}")


def known_hashes(outdir: str) -> set:
    s = set()
    if not os.path.isdir(outdir):
        return s
    for fn in os.listdir(outdir):
        fp = os.path.join(outdir, fn)
        if os.path.isfile(fp) and not fp.endswith(".part"):
            try:
                s.add(sha256_of(fp))
            except Exception:
                pass
    return s


def fetch_one(outdir: str, url: str, name: str, referer: str = "") -> str:
    os.makedirs(outdir, exist_ok=True)
    name = sanitize(name)
    dest = os.path.join(outdir, name)
    tmp = dest + ".part"
    n = download(url, tmp, referer=referer)
    h = sha256_of(tmp)
    existing = known_hashes(outdir)
    if h in existing:
        os.replace(tmp, dest)  # 内容已存在，覆盖同内容
        return f"DUP  {name}  {n}B"
    os.replace(tmp, dest)
    # 校验 PDF 头
    with open(dest, "rb") as f:
        head = f.read(5)
    if head != b"%PDF-":
        raise RuntimeError(f"非 PDF 文件头 {head!r}: {name}")
    return f"OK   {name}  {n}B  sha256={h[:12]}"


def main() -> int:
    if len(sys.argv) < 3:
        print("用法: nhc_fetch.py <outdir> <url|links.json> [save_name] [referer]")
        return 2
    outdir = sys.argv[1]
    arg2 = sys.argv[2]
    fails = 0
    if arg2.endswith(".json") or arg2.startswith("["):
        payload = arg2
        if payload.endswith(".json"):
            with open(payload, "r", encoding="utf-8") as f:
                items = json.load(f)
        else:
            items = json.loads(payload)
        for it in items:
            url = it["url"]
            name = it.get("name") or url.split("/")[-1]
            ref = it.get("src") or it.get("referer") or ""
            try:
                print(fetch_one(outdir, url, name, ref))
            except Exception as e:
                fails += 1
                print(f"FAIL {name}: {e}", file=sys.stderr)
    else:
        url = arg2
        name = sys.argv[3] if len(sys.argv) > 3 else url.split("/")[-1]
        ref = sys.argv[4] if len(sys.argv) > 4 else ""
        try:
            print(fetch_one(outdir, url, name, ref))
        except Exception as e:
            fails += 1
            print(f"FAIL {name}: {e}", file=sys.stderr)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
