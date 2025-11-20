# Twitter to Obsidian

Firefox 拡張機能で Twitter/X のツイートを簡単に Obsidian に保存します。

## 機能

- 🐦 Twitter/X のツイートをワンクリックで保存
- 📝 Frontmatter 付き Markdown ファイルとして保存
- 🖼️ ツイート内の画像 URL も自動保存
- 🔒 Obsidian Local REST API を使用した安全な保存
- 🔔 保存完了の通知表示

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

1. Firefox のツールバーにある拡張機能アイコンをクリック
2. 「Settings」ボタンをクリック
3. 以下を設定:
   - **API Endpoint**: Obsidian Local REST API の URL (デフォルト: `https://127.0.0.1:27124`)
   - **API Key**: Obsidian で生成した API キー
   - **Folder Path**: 保存先フォルダ (デフォルト: `Clippings/twitter`)
4. 「Test Connection」で接続確認
5. 「Save Settings」で設定を保存

### ツイートの保存

1. Twitter/X で保存したいツイートのページを開く
2. 拡張機能アイコンをクリック
3. 「Save Current Tweet」ボタンをクリック
4. 成功すると通知が表示されます

### 保存されるファイル

ファイル名: `{投稿者名}-{ツイートID}.md`

例: `elonmusk-1234567890.md`

```markdown
---
source: https://x.com/elonmusk/status/1234567890
author: @elonmusk
text: ツイートの本文がここに入ります
created: 2025-01-15T10:30:00Z
images:
  - https://pbs.twimg.com/media/xxxxx?format=jpg&name=large
tags:
  - twitter
  - clipping
---

ツイートの本文がここに入ります
```

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
