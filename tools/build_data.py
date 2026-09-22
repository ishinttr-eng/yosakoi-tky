#!/usr/bin/env python3
"""
第27回東京よさこい公式サイトから performances.json を生成する。

公式サイトは会場別の演舞スケジュールをPDF（前夜祭1枚・本祭1枚、各会場4列x複数ページ）
として配布しており、出演チーム一覧は別ページ（team_year/2026/）の静的HTMLで持っている。
このスクリプトは:
  1. トップページのHTMLから最新の演舞スケジュールPDFのURLを探す
     （ファイル名は主催者側の更新のたびに変わるため、リンクテキスト
      "10月10日" / "10月11日" を含むリンクを探す方式にしている。
      見出し文言が変わったらこの部分を直すこと）
  2. PDFをダウンロードしてテキスト抽出（pypdf）
  3. 表形式のテキストを会場列ごとにパース（時刻パターンで列を分割）
  4. team_year/2026/ ページから正式なチーム名・かな・地域一覧を取得し、
     PDF側の抽出名（改行欠落等でハイフンや引用符が化けることがある）を
     正規化キーで突き合わせて正式名称に解決する
  4.5. 各チームの個別ページ（team_year一覧のリンク先、107ページ程度）を取得し、
     紹介文・チーム画像・SNS/公式サイトリンクを performances.json の
     intro/image/sns フィールドに反映する
  5. 差分検出して changes.json に追記、checked.json を更新

実行:
    python3 tools/build_data.py
    (要: pip install -r tools/requirements.txt)

venues.json（会場の座標・開催日）はこのスクリプトの対象外。会場の追加・移設が
あった場合は手動で venues.json を編集すること。
"""
import json
import re
import sys
import time
import unicodedata
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    from pypdf import PdfReader
except ImportError:
    print("[build_data] pypdf が見つかりません。`pip install -r tools/requirements.txt` を実行してください。", file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = ROOT / "tools" / "raw"
JST = timezone(timedelta(hours=9))
TOP_URL = "https://tokyo-yosakoi.jp/"
TEAM_LIST_URL = "https://tokyo-yosakoi.jp/team_year/2026/"
UA = "tokyo-yosakoi-navi/1.0"

VENUE_ID_MAP = {
    "駅前メイン": "V-01",
    "アゼリア通り会場": "V-02",
    "池袋西口公園": "V-03",
    "みずき通り会場": "V-04",
    "四商店街会場": "V-05",
    "東武百貨店スカイデッキ": "V-06",
    "東武百貨店8Fスカイデッキ広場": "V-06",
    "大塚駅北口会場": "V-07",
    "巣鴨駅前会場": "V-08",
}

# 前夜祭(10/10)・本祭(10/11)それぞれのPDF内の会場列の並び順。
# 本祭は2ページ目に4会場続く（PDFテキストはページ区切りで抽出される）。
SCHEDULE_LAYOUTS = {
    "2026-10-10": [["駅前メイン", "アゼリア通り会場", "池袋西口公園", "東武百貨店スカイデッキ"]],
    "2026-10-11": [
        ["駅前メイン", "アゼリア通り会場", "池袋西口公園", "みずき通り会場"],
        ["四商店街会場", "東武百貨店8Fスカイデッキ広場", "大塚駅北口会場", "巣鴨駅前会場"],
    ],
}


def fetch_bytes(url, retries=3):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last_err = None
    for _ in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return res.read()
        except Exception as e:
            last_err = e
            time.sleep(1)
    raise last_err


def fetch_text(url):
    return fetch_bytes(url).decode("utf-8", errors="replace")


def find_schedule_pdf_urls():
    """トップページから"10月10日"/"10月11日"の演舞スケジュールPDFリンクを探す。"""
    html = fetch_text(TOP_URL)
    RAW.mkdir(parents=True, exist_ok=True)
    (RAW / "top.html").write_text(html, encoding="utf-8")

    links = re.findall(r'<a[^>]+href="([^"]+\.pdf)"[^>]*>(.*?)</a>', html, re.S)
    urls = {}
    for href, text in links:
        plain = re.sub(r"<[^>]+>", "", text)
        plain = re.sub(r"\s+", "", plain)
        if "10月10日" in plain:
            urls["2026-10-10"] = href
        elif "10月11日" in plain:
            urls["2026-10-11"] = href
    return urls


def extract_pdf_text(pdf_bytes):
    reader = PdfReader(__import__("io").BytesIO(pdf_bytes))
    return [page.extract_text() or "" for page in reader.pages]


TIME_RE = re.compile(r"\d{1,2}:\d{2}")
TIME_RANGE_RE = re.compile(r"\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}")
MARK_RE = re.compile(r"^[#0-9\uFF03]{1,2}$")


def split_row(line, n_venues):
    """1行に複数の論理行(改行欠落でPDF抽出時にくっついたもの)が
    含まれることがあるため、時刻の総数が n_venues の倍数になる前提で
    n_venues個ずつのグループに分割し、グループごとに (times, segments) を返す。"""
    times = list(TIME_RE.finditer(line))
    if len(times) < n_venues:
        return []
    n_groups = len(times) // n_venues
    results = []
    for g in range(n_groups):
        group_times = times[g * n_venues:(g + 1) * n_venues]
        segments = []
        for i in range(n_venues):
            start = group_times[i].end()
            if i + 1 < n_venues:
                end = group_times[i + 1].start()
            elif g + 1 < n_groups:
                end = times[(g + 1) * n_venues].start()
            else:
                end = len(line)
            segments.append(line[start:end].strip())
        results.append(([t.group() for t in group_times], segments))
    return results


def clean_cell(seg):
    """セグメントから (team_name_or_None, is_special) を返す"""
    seg = seg.strip()
    if not seg or "休憩" in seg:
        return None, False
    is_special = seg.startswith("◆")
    tokens = seg.split()
    if tokens and MARK_RE.match(tokens[-1]):
        tokens = tokens[:-1]
    name = " ".join(tokens).strip()
    if not name or re.fullmatch(r"[\d:\-]+", name):
        return None, False
    return name, is_special


def to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def minutes_to_hhmm(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def parse_schedule_page(text, venue_names, slot_len=6):
    text = TIME_RANGE_RE.sub(" ", text)
    lines = [l for l in text.splitlines() if l.strip() and TIME_RE.search(l)]
    n = len(venue_names)
    out = []
    for line in lines:
        for times, segments in split_row(line, n):
            for vname, t, seg in zip(venue_names, times, segments):
                name, is_special = clean_cell(seg)
                if name:
                    out.append({"venueId": VENUE_ID_MAP[vname], "start": t, "name": name, "isSpecial": is_special})
    return out


def parse_schedule_pdf(pdf_bytes, date):
    pages = extract_pdf_text(pdf_bytes)
    layouts = SCHEDULE_LAYOUTS[date]
    entries = []
    for i, venue_names in enumerate(layouts):
        page_text = pages[i] if i < len(pages) else ""
        entries.extend(parse_schedule_page(page_text, venue_names))
    result = []
    for e in entries:
        start_min = to_min(e["start"])
        result.append({
            "venueId": e["venueId"],
            "date": date,
            "start": e["start"],
            "startMin": start_min,
            "endMin": start_min + 6,
            "name": e["name"],
            "isSpecial": e["isSpecial"],
        })
    return result


TEAM_BLOCK_RE = re.compile(r'<div class="team_block">(.*?)</div>\s*(?=<div class="team_block">|<div class="pager|</div>\s*</section)', re.S)
TEXT1_RE = re.compile(r'class="team_text1"[^>]*>([^<]*)<')
TEXT2_RE = re.compile(r'class="team_text2"[^>]*href="([^"]+)"[^>]*>([^<]*)<')
TEXT3_RE = re.compile(r'class="team_text3"[^>]*>([^<]*)<')
TEXT4_RE = re.compile(r'class="team_text4"[^>]*>([^<]*)<')


def parse_team_list(html):
    teams = []
    for block in re.findall(r'<div class="team_block">.*?(?=<div class="team_block">|$)', html, re.S):
        m1, m2, m3, m4 = TEXT1_RE.search(block), TEXT2_RE.search(block), TEXT3_RE.search(block), TEXT4_RE.search(block)
        if not (m2 and m3 and m4):
            continue
        teams.append({
            "entryNo": (m1.group(1).replace("受付番号：", "").strip() if m1 else ""),
            "url": m2.group(1),
            "name": html_unescape(m2.group(2).strip()),
            "kana": html_unescape(m3.group(1).strip()),
            "region": html_unescape(m4.group(1).strip()),
        })
    return teams


DETAIL_AREA_RE = re.compile(r'<div class="detail_common_area">(.*?)</div>\s*</div>', re.S)
DETAIL_IMG_RE = re.compile(r'<img[\s\S]*?src="([^"]+)"')
DETAIL_PARA_RE = re.compile(r'<p class="wp-block-paragraph">(.*?)</p>', re.S)
SNS_LINK_RE = re.compile(r'class="team_sns_link"\s+href="([^"]+)"')


def fetch_team_detail(url):
    """チーム個別ページから紹介文・チーム画像・SNS/公式サイトリンクを取得する。
    個別ページのマークアップが変わって取得できなくなった場合、intro等は空のまま
    performances.jsonに残り、アプリ側では単に非表示になるだけなので致命的ではない。"""
    html = fetch_text(url)
    area_m = DETAIL_AREA_RE.search(html)
    area = area_m.group(1) if area_m else ""
    img_m = DETAIL_IMG_RE.search(area)
    image = img_m.group(1) if img_m else ""
    paras = DETAIL_PARA_RE.findall(area)
    intro = "\n".join(html_unescape(re.sub(r"<[^>]+>", "", p)).strip() for p in paras).strip()
    sns = SNS_LINK_RE.findall(html)
    return {"image": image, "intro": intro, "sns": sns}


def enrich_teams_with_detail(teams):
    """各チームの個別ページを取得してintro/image/snsを付与する。
    107ページ程度なので逐次取得でも数十秒〜1分程度で終わる。1件失敗しても
    他のチームの取得を止めない。"""
    for t in teams:
        try:
            detail = fetch_team_detail(t["url"])
        except Exception as e:
            print(f"[build_data] チーム詳細の取得に失敗: {t['name']} ({t['url']}): {e}", file=sys.stderr)
            detail = {"image": "", "intro": "", "sns": []}
        t.update(detail)
        time.sleep(0.2)
    return teams


def html_unescape(s):
    import html as html_lib
    return html_lib.unescape(s)


NORMALIZE_STRIP_RE = re.compile(
    r"[\s\-~\u2010-\u2015\u301c\uff5e\u3000\"'\u2018\u2019\u201c\u201d\u2033\u3008-\u300f\(\)\uff08\uff09]+"
)


def normalize_name(name):
    return NORMALIZE_STRIP_RE.sub("", name)


def reconcile_with_teams(perfs, teams):
    team_by_norm = {normalize_name(t["name"]): t for t in teams}
    resolved, dropped = [], []
    for p in perfs:
        if p["isSpecial"]:
            resolved.append(p)
            continue
        key = normalize_name(p["name"])
        team = team_by_norm.get(key)
        if not team:
            candidates = [v for k, v in team_by_norm.items() if k and key.startswith(k)]
            if len(candidates) == 1:
                team = candidates[0]
        if team:
            p["name"] = team["name"]
            p["kana"] = team["kana"]
            p["region"] = team["region"]
            p["intro"] = team.get("intro", "")
            p["image"] = team.get("image", "")
            p["sns"] = team.get("sns", [])
            resolved.append(p)
        else:
            dropped.append(p)
    return resolved, dropped


def build_performances(raw_entries, teams):
    raw_entries.sort(key=lambda p: (p["date"], p["startMin"]))
    resolved, dropped = reconcile_with_teams(raw_entries, teams)
    order_counter = {}
    out = []
    for i, p in enumerate(resolved, start=1):
        key = (p["date"], p["name"])
        order_counter[key] = order_counter.get(key, 0) + 1
        out.append({
            "id": f"p-{i:04d}",
            "name": p["name"],
            "kana": p.get("kana", ""),
            "venueId": p["venueId"],
            "date": p["date"],
            "start": p["start"],
            "end": minutes_to_hhmm(p["endMin"]),
            "genre": "特別演舞" if p.get("isSpecial") else "",
            "region": p.get("region", ""),
            "intro": p.get("intro", ""),
            "awardEntry": "",
            "isU25": False,
            "order": order_counter[key],
            "image": p.get("image", ""),
            "sns": p.get("sns", []),
        })
    return out, dropped


QUOTE_TRANSLATION = str.maketrans({"‘": "'", "’": "'", "ʼ": "'", "`": "'", "“": '"', "”": '"'})


def normalize_for_diff(name):
    s = unicodedata.normalize("NFKC", name)
    s = s.translate(QUOTE_TRANSLATION)
    return re.sub(r"\s+", " ", s).strip()


def diff_performances(old_list, new_list):
    def nkey(p):
        return (p["venueId"], p["date"], p["start"], normalize_for_diff(p["name"]))

    old_by_key = {nkey(p): p for p in old_list}
    new_by_key = {nkey(p): p for p in new_list}
    added = [p for k, p in new_by_key.items() if k not in old_by_key]
    removed = [p for k, p in old_by_key.items() if k not in new_by_key]

    old_slots = {(p["venueId"], p["date"], p["start"]): p for p in old_list}
    new_slots = {(p["venueId"], p["date"], p["start"]): p for p in new_list}
    items = []
    handled = set()
    for slot, np in new_slots.items():
        op = old_slots.get(slot)
        if op and normalize_for_diff(op["name"]) != normalize_for_diff(np["name"]):
            items.append({"kind": "swap", "text": f"{op['name']} → {np['name']}（{slot[2]}〜）"})
            handled.add(np["name"])
            handled.add(op["name"])
    for p in added:
        if p["name"] not in handled:
            items.append({"kind": "added", "text": f"{p['name']} が追加されました"})
    for p in removed:
        if p["name"] not in handled:
            items.append({"kind": "removed", "text": f"{p['name']} が削除されました"})

    MODIFIED_FIELDS = [("end", "終了時刻"), ("genre", "ジャンル"), ("region", "活動地域")]
    for key, np in new_by_key.items():
        op = old_by_key.get(key)
        if not op:
            continue
        changes = []
        for field, label in MODIFIED_FIELDS:
            ov, nv = op.get(field, ""), np.get(field, "")
            if ov != nv:
                changes.append(f"{label}: {ov or '（空欄）'} → {nv or '（空欄）'}")
        if changes:
            items.append({"kind": "modified", "text": f"{np['name']}（{np['start']}〜）が変更されました: " + " / ".join(changes)})
    return items


def main():
    RAW.mkdir(parents=True, exist_ok=True)

    pdf_urls = find_schedule_pdf_urls()
    if "2026-10-10" not in pdf_urls or "2026-10-11" not in pdf_urls:
        print(f"[build_data] 演舞スケジュールPDFのリンクが見つかりませんでした: {pdf_urls}", file=sys.stderr)
        sys.exit(1)

    raw_entries = []
    for date, url in pdf_urls.items():
        pdf_bytes = fetch_bytes(url)
        (RAW / f"schedule_{date}.pdf").write_bytes(pdf_bytes)
        raw_entries.extend(parse_schedule_pdf(pdf_bytes, date))

    team_html = fetch_text(TEAM_LIST_URL)
    (RAW / "team_list.html").write_text(team_html, encoding="utf-8")
    teams = parse_team_list(team_html)
    if not teams:
        print("[build_data] チーム一覧を1件も抽出できませんでした。TEAM_BLOCK_RE等のセレクタを見直してください。", file=sys.stderr)
        sys.exit(1)
    teams = enrich_teams_with_detail(teams)

    performances, dropped = build_performances(raw_entries, teams)
    if not performances:
        print("[build_data] 出演情報を1件も抽出できませんでした。SCHEDULE_LAYOUTS等を見直してください。", file=sys.stderr)
        sys.exit(1)
    if dropped:
        print(f"[build_data] {len(dropped)} 件をチーム一覧と照合できず除外しました（ヘッダー注記等のノイズの可能性）", file=sys.stderr)
        for d in dropped[:20]:
            print(f"    dropped: {d['date']} {d['venueId']} {d['start']} {d['name']!r}", file=sys.stderr)

    old_perf_path = DATA / "performances.json"
    old_list = []
    if old_perf_path.exists():
        try:
            old_list = json.loads(old_perf_path.read_text(encoding="utf-8")).get("performances", [])
        except Exception:
            old_list = []

    now = datetime.now(JST).isoformat()
    out = {"updatedAt": now, "performances": performances}
    old_perf_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    checked = {"checkedAt": now}
    (DATA / "checked.json").write_text(json.dumps(checked, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    items = diff_performances(old_list, performances)
    if items:
        changes_path = DATA / "changes.json"
        changes = {"history": []}
        if changes_path.exists():
            try:
                changes = json.loads(changes_path.read_text(encoding="utf-8"))
            except Exception:
                pass
        changes.setdefault("history", []).insert(0, {"checkedAt": now, "items": items})
        changes["history"] = changes["history"][:20]
        changes_path.write_text(json.dumps(changes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[build_data] 差分 {len(items)} 件を検出しました")
    else:
        print("[build_data] 差分なし")

    print(f"[build_data] {len(performances)} 件の出演情報を書き出しました")


if __name__ == "__main__":
    main()
