#!/usr/bin/env python3
"""
全会場ペアの徒歩ルートを FOSSGIS OSRM から一括取得し、
data/routes.json（ポリライン・距離・所要時間）と data/walktimes.json（分数マトリクス）を更新する。

一度きりのセットアップ用。中断しても再実行時は取得済みペアをスキップして再開できる。

実行:
    python3 tools/build_routes.py
"""
import json
import sys
import time
import urllib.request
import urllib.parse
from pathlib import Path
from itertools import combinations

from jsonio import write_json

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OSRM_BASE = "https://routing.openstreetmap.de/routed-foot/route/v1/foot"
SLEEP_SEC = 0.3


def load_venues():
    venues = json.loads((DATA / "venues.json").read_text(encoding="utf-8"))["venues"]
    return venues


def load_routes():
    path = DATA / "routes.json"
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            # 握りつぶして空から作り直すと、取得済みの全ルートを取り直すことになる
            print(f"[build_routes] routes.json を読み込めません。手動で確認してください: {e}", file=sys.stderr)
            sys.exit(1)
    return {"routes": {}}


def fetch_route(a, b, retries=3):
    for attempt in range(retries):
        try:
            return _fetch_route_once(a, b)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def _fetch_route_once(a, b):
    url = f"{OSRM_BASE}/{a['lng']},{a['lat']};{b['lng']},{b['lat']}?overview=full&geometries=polyline"
    req = urllib.request.Request(url, headers={"User-Agent": "tokyo-yosakoi-navi/1.0"})
    with urllib.request.urlopen(req, timeout=15) as res:
        data = json.loads(res.read().decode("utf-8"))
    route = data["routes"][0]
    return {
        "distM": round(route["distance"]),
        "durMin": max(1, round(route["duration"] / 60)),  # 近接会場で0分にならないよう1分以上にする
        "poly": route["geometry"],
    }


def main():
    venues = load_venues()
    routes_doc = load_routes()
    routes = routes_doc.setdefault("routes", {})

    pairs = list(combinations(sorted(venues, key=lambda v: v["id"]), 2))
    total = len(pairs)
    done = 0
    failed = []
    for a, b in pairs:
        key = "|".join(sorted([a["id"], b["id"]]))
        if key in routes:
            done += 1
            continue
        try:
            routes[key] = fetch_route(a, b)
            print(f"[build_routes] {key} OK ({done+1}/{total})")
        except Exception as e:
            print(f"[build_routes] {key} FAILED: {e}", file=sys.stderr)
            failed.append(key)
        done += 1
        time.sleep(SLEEP_SEC)
        if done % 20 == 0:
            write_json(DATA / "routes.json", routes_doc)

    write_json(DATA / "routes.json", routes_doc)

    # walktimes.json を実測値で更新（無いペアは概算のままにする＝build_data.py側の役割）
    ids = [v["id"] for v in sorted(venues, key=lambda v: v["id"])]
    wt_path = DATA / "walktimes.json"
    wt = None
    if wt_path.exists():
        wt = json.loads(wt_path.read_text(encoding="utf-8"))
        # 会場一覧とずれていると行列のサイズが合わなくなるため、その場合は作り直す
        if wt.get("ids") != ids:
            print("[build_routes] walktimes.json の会場IDが現在の会場一覧と異なるため作り直します")
            wt = None
    if wt is None:
        wt = {"ids": ids, "minutes": [[0] * len(ids) for _ in ids]}
    id_index = {vid: i for i, vid in enumerate(wt["ids"])}
    for key, r in routes.items():
        a_id, b_id = key.split("|")
        if a_id in id_index and b_id in id_index:
            i, j = id_index[a_id], id_index[b_id]
            wt["minutes"][i][j] = r["durMin"]
            wt["minutes"][j][i] = r["durMin"]
    wt["source"] = "OSRM"
    write_json(wt_path, wt)
    print(f"[build_routes] 完了: {len(routes)}/{total} ペア")
    if failed:
        # 取得済み分は保存済み。再実行すれば未取得ペアだけを再開できる
        print(f"[build_routes] {len(failed)} ペアの取得に失敗しました: {failed}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
