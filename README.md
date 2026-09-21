# 東京よさこいナビ 2026

「第27回東京よさこい」（2026年10月10日・11日、東京都豊島区池袋ほか）の非公式ナビゲーターPWA。
ビルド不要のvanilla JS。地図はOpenStreetMap＋Leaflet、天気はOpen-Meteo、徒歩ルートはOSRM（FOSSGIS）を使用し、APIキー・自前サーバーは不要。

## ローカルで動かす

```bash
cd /Users/rhio/projects/yosakoi
python3 -m http.server 8080
# http://localhost:8080/ を開く
```

Service Workerがルート相対パスでキャッシュするため、`file://` では正しく動かない。必ず簡易HTTPサーバー経由で開くこと。

## ファイル構成

```
index.html / manifest.webmanifest / sw.js / icon.svg
css/style.css
js/app.js      UI本体
js/store.js    状態管理・データ読み込み
js/util.js     汎用関数
data/          静的JSON（venues / performances / walktimes / routes / tieup / checked / changes / app_changelog）
tools/         開発用（公開ディレクトリからは除外）
  build_data.py    公式演舞スケジュールPDF＋参加チーム一覧 → data/performances.json 変換＋差分検出
  build_routes.py  全会場ペアの徒歩ルートをOSRMから一括取得
  requirements.txt PDF処理に使う pypdf 等の依存関係
.github/workflows/
  update-data.yml   3時間ごとに公式データ再取得→自動コミット
  deploy-pages.yml  pushをトリガーにGitHub Pagesへデプロイ
  build-routes.yml  徒歩ルート取得を手動実行するためのワークフロー
```

## データについて

- `data/venues.json`（8会場: 池袋西口駅前広場/アゼリア通り会場/池袋西口公園/みずき通り会場/四商店街会場/東武百貨店8Fスカイデッキ広場/大塚駅北口会場/巣鴨駅前会場）は豊島区公式サイト・東京よさこい公式サイトの記載をもとに作成。座標はGoogleマップ検索による概算値（2026-09時点）で、通り名会場は代表点。
- `data/performances.json` は公式サイト（https://tokyo-yosakoi.jp/ ）の演舞スケジュールPDF（前夜祭・本祭）と参加チーム一覧ページから2026-09-21時点の内容を収集したもの。
- 公式サイトの情報は開催直前まで変動するため、`tools/build_data.py` とGitHub Actionsで自動追従する運用を想定（要: GitHub Pages公開・Actions有効化、および `pip install -r tools/requirements.txt`）。
- 演舞スケジュールPDFのファイル名・列レイアウトが変わった場合は `tools/build_data.py` 内の `find_schedule_pdf_urls` / `SCHEDULE_LAYOUTS` を見直すこと。チーム一覧ページのマークアップが変わった場合は `parse_team_list` 周辺のセレクタを見直すこと。差分検出が動かなくなった場合は `tools/raw/` に保存される生データ（PDF・HTML）を確認する。
- 徒歩ルート（`data/routes.json` / `data/walktimes.json`）は `tools/build_routes.py` でOSRM実測値を取得済み。

## 実装していない機能

感想メモ・★評価・スタンプラリー・アワード投票などフェス固有の任意機能は、東京よさこい公式サイト上で実施が確認できなかったため実装していない。

## 個人データの扱い

お気に入りの達成状況はすべて端末のlocalStorageにのみ保存され、外部には送信されない。
