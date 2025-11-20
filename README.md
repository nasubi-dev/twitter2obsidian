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

1. Twitter/X のブックマークページ（`https://x.com/i/bookmarks`）を開く
2. 右下に表示される「📚 Save All Bookmarks to Obsidian」ボタンをクリック
3. 自動的に全ブックマークをスクロールして収集
4. 順次 Obsidian に保存（進捗がボタンに表示されます）
5. 保存完了後、結果（保存数、スキップ数、失敗数）が表示されます

> **Note**: ブックマーク一括保存は無限スクロールに対応しています。すべてのブックマークが自動的に収集されるまで待機します。

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
  - https://pbs.twimg.com/media/xxxxx?format=jpg&name=large
  - https://pbs.twimg.com/media/yyyyy?format=jpg&name=large
---

ツイートの本文がここに入ります

![Elon Musk - Tweet 1234567890 - Photo 1](https://pbs.twimg.com/media/xxxxx?format=jpg&name=large)
![Elon Musk - Tweet 1234567890 - Photo 2](https://pbs.twimg.com/media/yyyyy?format=jpg&name=large)
```

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
- Firefox が`https://127.0.0.1/*`へのアクセスを許可しているか確認

### 「Not a tweet page」エラー

- Twitter/X の個別ツイートページ（`https://x.com/username/status/1234567890`）を開いているか確認
- タイムラインではなく、個別ツイートのページで実行してください
- URL バーアイコンはツイートページでのみ表示されます

### ブックマーク保存ボタンが表示されない

- ブックマークページ（`https://x.com/i/bookmarks`）を開いているか確認
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

## ライセンス

MIT License

## 参考

- [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)
- [Firefox Extension Workshop](https://extensionworkshop.com/)
