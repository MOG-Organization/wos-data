# WoS 王国データ

Whiteout Stats API のデータを毎日自動で取得し、王国一覧・王国ページ・同盟ページを GitHub Pages で公開するサイトです。サーバーは不要で、GitHub だけで動きます（公開リポジトリなら GitHub Actions は無料）。

## 構成

- `public/index.html` … サイト本体（王国一覧 / 王国ページ / 同盟ページ）
- `public/data/` … 取得したデータ（自動で更新されるので手で触らない）
- `scripts/fetch-data.mjs` … データ取得スクリプト
- `.github/workflows/update.yml` … 毎日 04:30（日本時間）に取得して公開
- `config.json` … 毎回必ず取得する王国・同盟の設定

## config.json の項目

- `watch_states` … 毎回取得する王国（王国ページのランキングが毎日更新される）
- `watch_alliances` … 毎回取得する同盟（例: `{ "kid": 3345, "tag": "MOG" }`。タグは大文字小文字を区別）
- `top_alliances_per_watched_state` … 監視中の王国で、戦力上位から何同盟の名簿を取るか
- `detail_per_run` … 監視外の王国の詳細を1回に何件取るか（残りは次回に続きから）
- `daily_safety_margin` … 1日の回数枠のうち、使わずに残しておく回数

## 1日の回数枠の使い方（無料キー: 1日5,000回）

1. 王国一覧（全王国、約40回）
2. 監視中の王国の詳細
3. 監視中の同盟の名簿
4. 残りの枠で、その他の王国の詳細を順番に（約1,200件 → 全王国が約3〜4日で一巡）
