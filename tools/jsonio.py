"""build_data.py / build_routes.py 共通のJSON入出力ヘルパー"""
import json
import os


def write_json(path, obj):
    """一時ファイルに書いてから置き換える（途中で落ちても既存ファイルを壊さない）"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
