# シフト作成Webアプリ (shift-scheduler-app)

GAS + スプレッドシートで、希望シフト集約 → 自動シフト作成 → 違反チェック をワンストップで行うWebアプリです。

## 1. スプレッドシート側の準備

1. 新しいGoogleスプレッドシートを作成する（例: `シフト管理DB`）。
2. スクリプトエディタを開く（拡張機能 > Apps Script）、または後述のclaspで作成したスクリプトを
   スタンドアロンのまま使う場合は、スクリプトプロパティ `SPREADSHEET_ID` にこのスプレッドシートのIDを設定する
   （`ファイル > プロジェクトの設定 > スクリプト プロパティ`）。
3. 初回のみ、スクリプトエディタで `initializeSpreadsheetStructure` 関数を実行し、
   `従業員マスタ / 希望シフト / 制約表 / 完成シフト / 違反ログ` の5シートを自動作成する。
4. 「従業員マスタ」シートに従業員（約20名）を入力する。「資格」列は責任者なら `TRUE`、それ以外は空欄。

## 2. ローカル開発環境の構築（clasp）

### 2-1. 事前準備

```bash
# Node.js が入っている前提
npm install -g @google/clasp

# Googleアカウントでログイン（ブラウザが開く）
clasp login
```

Google側で「Apps Script API」を有効化しておく必要があります（初回のみ）:
https://script.google.com/home/usersettings で「Google Apps Script API」をONにする。

### 2-2. プロジェクトを取得 or 新規作成

**A. 新規にApps Scriptプロジェクトを作る場合**

```bash
cd shift-scheduler-app
clasp create --type webapp --title "シフト作成システム" --rootDir ./src
```

実行すると `src/` 配下に `appsscript.json` が上書き生成されるので、
本リポジトリの `src/appsscript.json` の内容（webapp設定など）で上書きし直してください。
また作成された `.clasp.json` はコミットしません（`.gitignore` 済み）。

**B. 既存のApps Scriptプロジェクトに紐づける場合**

```bash
cp .clasp.json.example .clasp.json
# .clasp.json の scriptId を、対象スクリプトのIDに書き換える
# （スクリプトIDは スクリプトエディタ > プロジェクトの設定 に表示されます）
```

### 2-3. コードをGASへpush / GASから取得

```bash
# ローカル -> GAS へ反映
clasp push

# GAS -> ローカル へ反映（GAS側で直接編集した場合の取り込み）
clasp pull
```

### 2-4. Webアプリとしてデプロイ

```bash
clasp deploy --description "初回リリース"

# 更新時（既存デプロイの中身を差し替える）
clasp deployments        # デプロイIDを確認
clasp deploy -i <デプロイID> --description "v2 シフト生成ロジック改善"
```

デプロイ後に表示される `https://script.google.com/macros/s/.../exec` がWebアプリのURLです。

### 2-5. ブラウザで開発中の確認をしたい場合

```bash
clasp open
```

でスクリプトエディタが開くので、`表示 > 実行数` やログでデバッグできます。
またWeb UIの動作確認は `clasp deploy` せずとも、スクリプトエディタから
「デプロイ > テストデプロイ」で都度URLを発行して確認できます。

## 3. GitHubへのバージョン管理

```bash
cd shift-scheduler-app
git init
git add .
git commit -m "Initial commit: シフト作成Webアプリ scaffold"

# GitHub上に空リポジトリを作成後
git remote add origin https://github.com/<あなたのアカウント>/shift-scheduler-app.git
git branch -M main
git push -u origin main
```

以降の開発フローの目安:

```bash
# 1. GAS側で挙動確認しながらローカルでコード編集
# 2. GASへ反映して手動テスト
clasp push

# 3. 問題なければGitにコミット
git add .
git commit -m "fix: 遅番翌日早番チェックの境界条件を修正"
git push

# 4. リリースする場合
clasp deploy -i <デプロイID> --description "v3"
```

## 4. 運用上の注意

- `appsscript.json` の `webapp.access` は初期値を `ANYONE`（リンクを知っていれば誰でも）にしています。
  社内Google Workspaceのみに絞りたい場合は `DOMAIN` に変更してください（個人Gmailアカウントの組織では利用不可）。
- 「完成シフト」シートを手動で直接編集した場合は、必ず③違反チェックを再実行してください
  （手動編集はアプリ側の整合性チェックを経由しないため）。
- シフト自動生成は「連勤日数・遅番翌日早番」の判定に**前週の「完成シフト」シートのデータ**を参照します。
  週をまたいで初めて使う場合は、最初の週だけこの持ち越し判定が空（実績なし）になります。
