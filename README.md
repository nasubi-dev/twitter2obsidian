# Twitter to Obsidian

Firefox 拡張機能で Twitter/X のツイートを簡単に Obsidian に保存します。

## 機能

- 🐦 Twitter/X のツイートをワンクリックで保存
- 📚 ブックマークを一括で Obsidian に保存（無限スクロール対応）
- ⌨️ キーボードショートカット（`Alt+O`）で素早く保存
- 📝 Frontmatter 付き Markdown ファイルとして保存
- 🖼️ ツイート内の画像 URL も自動保存
- 🎥 動画ツイート対応（サムネイル、リンク、iframe 埋め込み）
- 🔒 Obsidian Local REST API を使用した安全な保存
- 🔔 トースト通知とシステム通知で保存状態をお知らせ

## 前提条件

1. **Obsidian**がインストールされていること
2. **Obsidian Local REST API プラグイン**がインストールされていること
   - Obsidian Settings → Community Plugins → Browse
   - "Local REST API"を検索してインストール
   - プラグインを有効化して API キーを生成

## インストール方法

### 開発版として読み込む

1. このリポジトリをクローンまたはダウンロード
2. Firefox を開いて`about:debugging`に移動
3. 「この Firefox」をクリック
4. 「一時的なアドオンを読み込む」をクリック
5. このフォルダの`manifest.json`を選択

## 使い方

### 初期設定

1. Firefox で `about:addons` を開く
2. 「Twitter to Obsidian」の「設定」タブをクリック
3. 以下を設定:
   - **API Endpoint**: Obsidian Local REST API の URL (デフォルト: `https://127.0.0.1:27124`)
   - **API Key**: Obsidian で生成した API キー
   - **Folder Path**: 保存先フォルダ (デフォルト: `Clippings/twitter`)
   - **Show Notifications**: システム通知の ON/OFF
4. 「Test Connection」で接続確認
5. 「Save Settings」で設定を保存

### ツイートの保存

#### 方法 1: URL バーアイコンをクリック

1. Twitter/X で保存したいツイートのページを開く（`https://x.com/*/status/*`）
2. URL バー右側に表示される拡張機能アイコンをクリック
3. 成功するとページ内にトースト通知が表示されます

#### 方法 2: キーボードショートカット

1. Twitter/X で保存したいツイートのページを開く
2. `Alt+O` キーを押す
3. 成功するとページ内にトースト通知が表示されます

### ブックマークの一括保存

1. Twitter/X のブックマークページ（`https://x.com/i/history`）を開く
2. 右下に表示される「📚 Save All Bookmarks to Obsidian」ボタンをクリック
3. 自動的に全ブックマークをスクロールして収集
4. 順次 Obsidian に保存（進捗がボタンに表示されます）
5. 保存完了後、結果（保存数、スキップ数、失敗数）が表示されます

> **Note**: ブックマーク一括保存は無限スクロールに対応しています。すべてのブックマークが自動的に収集されるまで待機します。

> **Note**: X はブックマークを「履歴」ページに統合したため、`/i/bookmarks` は `/i/history` にリダイレクトされます。ボタンが表示されるのはブックマークタブ（`/i/history`）だけで、いいねタブ（`/i/history/likes`）では表示されません。

### 保存されるファイル

ファイル名: `{投稿者の表示名}-{ツイートID}.md`

例: `Elon Musk-1234567890.md`

#### テキスト・画像ツイートの場合

```markdown
---
source: https://x.com/elonmusk/status/1234567890
author: Elon Musk
text: ツイートの本文がここに入ります
date: 2025-01-15
images:
  - "[[assets/twitter/xxxxx.webp]]"
  - "[[assets/twitter/yyyyy.webp]]"
image_urls:
  - https://pbs.twimg.com/media/xxxxx?format=jpg&name=large
  - https://pbs.twimg.com/media/yyyyy?format=jpg&name=large
---

ツイートの本文がここに入ります

![[assets/twitter/xxxxx.webp]]
![[assets/twitter/yyyyy.webp]]
```

画像は保存時に `pbs.twimg.com` から webp（large）で取得し、Vault の `assets/twitter/<メディアID>.webp` に書き込みます。元のポストが削除されても画像が残るようにするためです。元の URL は `image_urls`（引用元は `quoted_image_urls`）に残ります。画像の取得に失敗した場合は、その画像だけ従来どおり URL のまま保存し、ノートの保存は止めません。経緯は [docs/notes/画像のローカル保存.md](docs/notes/画像のローカル保存.md)。

#### 動画ツイートの場合

```markdown
---
source: https://x.com/username/status/1234567890
author: Username
text: 動画付きツイート
date: 2025-01-15
images:
  - https://pbs.twimg.com/media/xxxxx?format=jpg&name=large
---

動画付きツイート

🎥 [Watch Video on X](https://x.com/username/status/1234567890)

<iframe src="https://x.com/username/status/1234567890" width="550" height="700" frameborder="0" allowfullscreen></iframe>
```

> **Note**: 動画ツイートの場合、`images` には動画のサムネイル画像が含まれますが、本文には表示されません。代わりに動画リンクと iframe 埋め込みが表示されます。

## トラブルシューティング

### 「Please configure API settings first」エラー

- Settings で API Endpoint と API Key が正しく設定されているか確認
- Test Connection で接続をテスト

### 「Connection failed」エラー

- Obsidian が起動しているか確認
- Local REST API プラグインが有効になっているか確認
- API キーが正しいか確認

**`Cannot reach ...` と出る場合（自己署名証明書）**

Local REST API の HTTPS ポート（27124）は自己署名証明書を使っており、Firefox はこれを拒否します。拡張のバックグラウンドページからは証明書の警告を承認できないため、拡張をリロードしても直りません。次のどちらかで解消します。

- **HTTP ポートを使う（簡単）**: Endpoint を `http://127.0.0.1:27123` にする。ループバック限定なので外部には露出しません
- **証明書を承認する**: Firefox の通常タブで `https://127.0.0.1:27124/` を開き、警告を承認してから再実行

### 「Failed to save: 404」エラー

保存先フォルダが Vault 内に存在するか確認してください。Settings の Folder Path は Vault ルートからの相対パス（例: `Clippings/twitter`）で、先頭・末尾のスラッシュは不要です。

### 「Not a tweet page」エラー

- Twitter/X の個別ツイートページ（`https://x.com/username/status/1234567890`）を開いているか確認
- タイムラインではなく、個別ツイートのページで実行してください
- URL バーアイコンはツイートページでのみ表示されます

### ブックマーク保存ボタンが表示されない

- ブックマークページ（`https://x.com/i/history`）を開いているか確認
- いいねタブ（`/i/history/likes`）ではボタンは表示されません
- ページ読み込み後、数秒待ってからボタンが表示されます
- 他のページに移動するとボタンは自動的に消えます

## 技術仕様

- **対象ブラウザ**: Firefox 109+
- **Manifest Version**: 2
- **API**: Obsidian Local REST API
- **言語**: JavaScript (Vanilla)

## 開発

### 必要なツール

- Firefox Developer Edition (推奨)
- Obsidian
- Obsidian Local REST API プラグイン

### デバッグ

1. `about:debugging` → 「この Firefox」→ 拡張機能の「調査」ボタン
2. コンソールでログを確認

### パッケージング

```bash
# web-extのインストール
npm install -g web-ext

# パッケージング
web-ext build
```

### 保存済みノートに引用元を後付けする

引用リツイート対応より前に保存したノートには引用元の情報が入っていません。`scripts/patch-quotes.mjs` が X の公開 syndication API から取得して後付けします（Node.js 18+ が必要）。

対象フォルダは環境変数 `T2O_VAULT_DIR` または `--vault` で指定します。

```bash
export T2O_VAULT_DIR="$HOME/Documents/obsidian/Clippings/twitter"

# ドライラン(書き込みなし)。何件パッチされるか確認する
node scripts/patch-quotes.mjs

# 問題なければ書き込む
node scripts/patch-quotes.mjs --apply
```

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `T2O_VAULT_DIR` | （必須） | 対象フォルダ。`--vault <path>` が優先 |
| `T2O_CACHE_FILE` | `scripts/.quote-patch-cache.json` | 再開用キャッシュの位置 |
| `T2O_DELAY_MS` | `400` | リクエスト間の待機ミリ秒 |

### 保存済みノートの画像を Vault に取り込む

画像のローカル保存に対応する前のノートは、`pbs.twimg.com` の画像を URL で表示しているだけです。`scripts/localize-images.mjs` が画像を `<vault>/assets/twitter/` にダウンロードし、ノートの参照をローカルの画像に書き換えます。取得できなかった画像（ポスト削除などで 404 / 403）は URL のまま残し、frontmatter に `images_lost: true` を付けます。何度実行しても同じ結果になります。

```bash
export T2O_VAULT_DIR="$HOME/Documents/obsidian/Clippings/twitter"

# ドライラン(HEAD で生死だけ確認、書き込みなし)
node scripts/localize-images.mjs

# 問題なければ書き込む
node scripts/localize-images.mjs --apply
```

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `T2O_VAULT_DIR` | （必須） | 対象フォルダ。`--vault <path>` が優先。Vault のルートは親をたどって `.obsidian` のある場所を使う |
| `T2O_DELAY_MS` | `300` | リクエスト間の待機ミリ秒 |
| `T2O_CONCURRENCY` | `3` | 同時リクエスト数 |

既存の本文と `created` / `updated` などのプロパティは保持されます。処理済みのツイート ID はキャッシュに記録されるため、中断しても再開できます。

## ライセンス

MIT License

## 参考

- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
- [Firefox Extension Workshop](https://extensionworkshop.com/)
