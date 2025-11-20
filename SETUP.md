# セットアップガイド

## 1. Obsidian Local REST API プラグインのセットアップ

### インストール

1. Obsidian を起動
2. Settings (⚙️) → Community plugins を開く
3. 「Browse」をクリック
4. 検索ボックスに「Local REST API」と入力
5. 「Install」をクリック
6. 「Enable」をクリックして有効化

### API キーの生成

1. Settings → Local REST API を開く
2. 「API Key」セクションで「Generate New Key」をクリック
3. 生成された API キーをコピー（このキーは後で使用します）

### HTTPS 設定

Local REST API はデフォルトで HTTPS を使用します。ブラウザが自己署名証明書を受け入れる必要があります。

1. Firefox で `https://127.0.0.1:27124/` を開く
2. 「警告: 潜在的なセキュリティリスク」が表示されたら「詳細」をクリック
3. 「危険性を承知で続行」をクリック
4. 接続が確立されれば OK

## 2. Firefox 拡張機能のインストール

### 開発モードで読み込む

1. Firefox を開く
2. アドレスバーに `about:debugging` と入力して Enter
3. 左側のメニューから「この Firefox」をクリック
4. 「一時的なアドオンを読み込む」ボタンをクリック
5. このプロジェクトフォルダの `manifest.json` を選択

### アイコンの準備

現在、アイコンファイルがありません。以下の方法で準備してください:

#### オプション 1: プレースホルダー画像を作成

```bash
cd icons/
# 48x48と96x96のPNG画像を作成してください
```

#### オプション 2: シンプルなアイコンを用意

- Twitter 風の青い鳥のアイコン
- Obsidian のロゴとの組み合わせ
- サイズ: 48x48px と 96x96px

## 3. 拡張機能の設定

### 初回設定

1. Firefox のツールバーに表示された拡張機能アイコンをクリック
2. 「Settings」ボタンをクリック
3. 以下の情報を入力:

   **API Endpoint**

   ```
   https://127.0.0.1:27124
   ```

   **API Key**

   ```
   （先ほどObsidianで生成したAPIキーを貼り付け）
   ```

   **Folder Path**

   ```
   Clippings/twitter
   ```

   ※保存先フォルダ。Obsidian vault のルートからの相対パス

4. 「Show save notifications」にチェック（推奨）
5. 「Test Connection」をクリックして接続をテスト
6. 「Connection successful!」と表示されたら「Save Settings」をクリック

### 保存先フォルダの準備

Obsidian で保存先フォルダを作成しておきます:

1. Obsidian で vault を開く
2. 左サイドバーで右クリック → 「New folder」
3. フォルダ名: `Clippings`
4. `Clippings`フォルダ内に `twitter` フォルダを作成

または、最初のツイート保存時に自動的に作成されます。

## 4. 動作確認

### テスト手順

1. Twitter/X で任意のツイートを開く

   - 例: `https://x.com/username/status/1234567890`
   - タイムラインではなく、個別ツイートのページを開いてください

2. 拡張機能アイコンをクリック

3. 「Save Current Tweet」ボタンをクリック

4. 成功すると以下が表示されます:

   - ポップアップに「✓ Tweet saved successfully!」
   - （設定で有効にした場合）ブラウザ通知

5. Obsidian を確認:
   - `Clippings/twitter/` フォルダに新しいマークダウンファイルが作成されている
   - ファイル名: `username-1234567890.md`

### 確認項目

- [ ] ファイルが正しい場所に作成されている
- [ ] Frontmatter が正しく生成されている
- [ ] ツイート本文が保存されている
- [ ] 画像付きツイートの場合、images フィールドに画像 URL が含まれている
- [ ] 同じツイートを再度保存しようとすると「already saved」と表示される

## トラブルシューティング

### よくある問題

#### 1. 「Connection failed」エラー

**原因と対処**:

- Obsidian が起動していない → Obsidian を起動
- Local REST API プラグインが無効 → プラグインを有効化
- API キーが間違っている → Obsidian で確認して再入力
- HTTPS が信頼されていない → 上記の「HTTPS 設定」を再度実施

#### 2. 「Not a tweet page」エラー

**原因と対処**:

- タイムラインページで実行している → 個別ツイートページ（`/status/`を含む URL）を開く

#### 3. 「Could not find tweet element」エラー

**原因と対処**:

- ページの読み込みが完了していない → ページを更新して再試行
- Twitter/X の DOM 構造が変更された → 開発者に報告

#### 4. 拡張機能アイコンが表示されない

**原因と対処**:

- 拡張機能が正しく読み込まれていない → `about:debugging`で確認
- Firefox の再起動が必要 → Firefox を再起動

## 次のステップ

### Obsidian での活用

保存したツイートを Obsidian で活用する方法:

1. **Dataview で一覧表示**

   ```dataview
   TABLE author, text, created
   FROM "Clippings/twitter"
   SORT created DESC
   ```

2. **タグで検索**

   - `#twitter` または `#clipping` タグで検索

3. **画像の表示**
   - Frontmatter の`images`フィールドの URL を使用

### ブックマーク一括保存（将来実装予定）

現在は個別ツイートの保存のみ対応しています。ブックマーク一括保存機能は将来のバージョンで実装予定です。

## サポート

問題が解決しない場合は、以下の情報を含めて Issue を作成してください:

- Firefox のバージョン
- Obsidian のバージョン
- Local REST API プラグインのバージョン
- エラーメッセージの全文
- 実行しようとしたツイートの URL（可能であれば）
