#!/usr/bin/env node
/**
 * 既存の保存済みツイート(.md)に、引用元(quote tweet)の情報を後付けするパッチ。
 *
 * 各ファイルのツイートIDを X の公開 syndication API で再取得し、
 * quoted_tweet がある場合のみ:
 *   - frontmatter に quoted_author / quoted_text / quoted_source / quoted_images を追加
 *   - 本文末尾に「引用元:」ブロックを追記
 * 既存の本文・プロパティ(created/updated 等)はそのまま保持する。
 *
 * 対象フォルダは環境変数 T2O_VAULT_DIR か --vault で指定する(必須)。
 * 拡張の保存先(既定 <vault>/Clippings/twitter)を絶対パスで渡すこと。
 *
 * 使い方:
 *   export T2O_VAULT_DIR="$HOME/Documents/obsidian/Clippings/twitter"
 *   node scripts/patch-quotes.mjs                     # ドライラン(書き込みなし)
 *   node scripts/patch-quotes.mjs --apply             # 実際に書き込む
 *
 *   # 環境変数の代わりに引数でも渡せる
 *   node scripts/patch-quotes.mjs --vault ~/path/to/twitter --apply
 *
 * 環境変数:
 *   T2O_VAULT_DIR   対象フォルダ(必須。--vault が優先)
 *   T2O_CACHE_FILE  再開用キャッシュの位置(任意。既定 scripts/.quote-patch-cache.json)
 *   T2O_DELAY_MS    リクエスト間の待機ミリ秒(任意。既定 400)
 *
 * 中断しても再開できるよう、処理済みIDをキャッシュに記録する。
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APPLY = process.argv.includes("--apply");

/** 先頭の ~ をホームディレクトリに展開する(シェルを介さず渡された場合の保険) */
function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** --vault <path> / --vault=<path> を読む */
function parseVaultArg(argv) {
  const eq = argv.find((a) => a.startsWith("--vault="));
  if (eq) return eq.slice("--vault=".length);

  const i = argv.indexOf("--vault");
  if (i >= 0) return argv[i + 1];

  return undefined;
}

const USAGE = `対象フォルダが指定されていません。

  export T2O_VAULT_DIR="$HOME/Documents/obsidian/Clippings/twitter"
  node scripts/patch-quotes.mjs            # ドライラン
  node scripts/patch-quotes.mjs --apply    # 書き込み

または:
  node scripts/patch-quotes.mjs --vault <対象フォルダ> [--apply]`;

/** 対象フォルダを解決する。未指定・不正なら usage を出して終了 */
async function resolveVaultDir() {
  const raw = parseVaultArg(process.argv) || process.env.T2O_VAULT_DIR;

  if (!raw || raw.startsWith("--")) {
    console.error(USAGE);
    process.exit(1);
  }

  const dir = path.resolve(expandHome(raw));

  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    console.error(`対象フォルダが見つかりません: ${dir}`);
    process.exit(1);
  }
  if (!stat.isDirectory()) {
    console.error(`対象がフォルダではありません: ${dir}`);
    process.exit(1);
  }

  return dir;
}

const CACHE_FILE = process.env.T2O_CACHE_FILE
  ? path.resolve(expandHome(process.env.T2O_CACHE_FILE))
  : path.join(__dirname, ".quote-patch-cache.json");

// X への負荷を抑えるための待機
const DELAY_MS = Number(process.env.T2O_DELAY_MS) > 0
  ? Number(process.env.T2O_DELAY_MS)
  : 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ツイートIDから syndication API 用トークンを生成 (react-tweet と同じ算出) */
function getToken(id) {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, "");
}

/** 単一ツイートを取得。存在しない/取得失敗時は null */
async function fetchTweet(id) {
  const token = getToken(id);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=ja`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
  });
  if (!res.ok) return null;
  return res.json();
}

/** background.js の escapeFrontmatterString と同じ挙動 */
function escapeFrontmatterString(str) {
  if (!str) return "";
  if (str.includes(":") || str.includes("\n") || str.includes('"')) {
    return '"' + str.replace(/"/g, '\\"').replace(/\n/g, " ") + '"';
  }
  return str;
}

/** mediaDetails(photo)を high quality URL の配列に変換 */
function photoUrls(media) {
  return (media || [])
    .filter((m) => m.type === "photo" && m.media_url_https)
    .map((m) => m.media_url_https.replace(/\.[a-zA-Z]+$/, "") + "?format=jpg&name=large");
}

function hasVideoMedia(media) {
  return (media || []).some((m) => m.type === "video" || m.type === "animated_gif");
}

/** quoted_tweet(JSON)を内部表現に変換 */
function toQuoted(qt) {
  const screen = qt.user?.screen_name || "";
  let text = (qt.text || "").trim();
  // 末尾の t.co(メディア/引用リンク)を除去して本文だけに寄せる
  text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/u, "").trim();
  return {
    username: (qt.user?.name || "").trim(),
    handle: screen ? "@" + screen : "",
    text,
    sourceUrl: screen && qt.id_str ? `https://x.com/${screen}/status/${qt.id_str}` : "",
    images: photoUrls(qt.mediaDetails),
    hasVideo: hasVideoMedia(qt.mediaDetails),
  };
}

/** background.js の generateQuotedSection と同じ出力 */
function generateQuotedSection(quoted) {
  const author = quoted.handle ? `${quoted.username} (${quoted.handle})` : quoted.username;

  let section = "\n\n---\n\n引用元:";
  if (author) section += ` ${author}`;
  if (quoted.sourceUrl) section += ` - [${quoted.sourceUrl}](${quoted.sourceUrl})`;
  section += "\n\n";

  if (quoted.text) {
    section += quoted.text.split("\n").map((l) => `> ${l}`).join("\n") + "\n";
  }

  if (quoted.hasVideo && quoted.sourceUrl) {
    section += `\n🎥 [Watch Video on X](${quoted.sourceUrl})\n`;
  } else if (quoted.images.length > 0) {
    section += "\n";
    quoted.images.forEach((img, i) => {
      section += `![${quoted.username} - Quoted Photo ${i + 1}](${img})\n`;
    });
  }
  return section;
}

/** frontmatter に quoted_* を追加した新しいファイル内容を返す */
function patchContent(content, quoted) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null; // frontmatter が無いファイルは対象外

  let fm = fmMatch[1];

  let extra = "";
  if (quoted.username) extra += `quoted_author: ${escapeFrontmatterString(quoted.username)}\n`;
  if (quoted.text) extra += `quoted_text: ${escapeFrontmatterString(quoted.text)}\n`;
  if (quoted.sourceUrl) extra += `quoted_source: ${quoted.sourceUrl}\n`;
  if (quoted.images.length > 0) {
    extra += "quoted_images:\n";
    quoted.images.forEach((img) => (extra += `  - ${img}\n`));
  }
  extra = extra.replace(/\n$/, ""); // 末尾改行は結合時に付与

  // created/updated があればその手前に、無ければ末尾に挿入
  const lines = fm.split("\n");
  const insertAt = lines.findIndex((l) => /^(created|updated):/.test(l));
  if (insertAt >= 0) {
    lines.splice(insertAt, 0, ...extra.split("\n"));
  } else {
    lines.push(...extra.split("\n"));
  }
  fm = lines.join("\n");

  const newFrontmatter = `---\n${fm}\n---\n`;
  const body = content.slice(fmMatch[0].length);
  return newFrontmatter + body + generateQuotedSection(quoted);
}

async function loadCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return { done: {} }; // id -> "quoted" | "noquote" | "missing"
  }
}

async function main() {
  const vaultDir = await resolveVaultDir();
  const cache = await loadCache();
  const files = (await fs.readdir(vaultDir)).filter((f) => f.endsWith(".md"));

  console.log(`対象フォルダ: ${vaultDir}`);

  let scanned = 0,
    patched = 0,
    skippedExisting = 0,
    noQuote = 0,
    missing = 0,
    errors = 0;

  console.log(`対象: ${files.length} 件  モード: ${APPLY ? "APPLY (書き込み)" : "DRY-RUN (確認のみ)"}`);

  for (const file of files) {
    const idMatch = file.match(/-(\d+)\.md$/);
    if (!idMatch) continue;
    const id = idMatch[1];
    const filePath = path.join(vaultDir, file);

    const content = await fs.readFile(filePath, "utf8");
    if (/^quoted_source:/m.test(content)) {
      skippedExisting++;
      continue; // 既に引用情報あり
    }

    if (cache.done[id] && cache.done[id] !== "quoted") {
      // 前回 引用なし/削除 と判定済み → 再取得しない
      if (cache.done[id] === "noquote") noQuote++;
      else missing++;
      continue;
    }

    scanned++;
    try {
      const tweet = await fetchTweet(id);
      await sleep(DELAY_MS);

      if (!tweet || tweet.tombstone || !tweet.user) {
        cache.done[id] = "missing";
        missing++;
        continue;
      }
      if (!tweet.quoted_tweet) {
        cache.done[id] = "noquote";
        noQuote++;
        continue;
      }

      const quoted = toQuoted(tweet.quoted_tweet);
      const newContent = patchContent(content, quoted);
      if (!newContent) {
        errors++;
        continue;
      }

      if (APPLY) {
        await fs.writeFile(filePath, newContent, "utf8");
      }
      cache.done[id] = "quoted";
      patched++;
      console.log(`${APPLY ? "✓ patched" : "→ would patch"}: ${file}  (引用元 ${quoted.handle})`);
    } catch (e) {
      errors++;
      console.error(`✗ error: ${file}: ${e.message}`);
    }

    // 進捗を逐次保存(中断しても再開可能)
    if (scanned % 20 === 0) await fs.writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");
  }

  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), "utf8");

  console.log("\n==== 結果 ====");
  console.log(`引用ありパッチ : ${patched} ${APPLY ? "(書込済)" : "(ドライラン)"}`);
  console.log(`引用なし       : ${noQuote}`);
  console.log(`取得できず/削除 : ${missing}`);
  console.log(`既に引用情報あり: ${skippedExisting}`);
  console.log(`エラー         : ${errors}`);
  if (!APPLY && patched > 0) console.log("\n問題なければ `node scripts/patch-quotes.mjs --apply` で書き込みます。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
