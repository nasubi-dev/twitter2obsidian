#!/usr/bin/env node
/**
 * 保存済みツイート(.md)が参照している pbs.twimg.com の画像を vault に取り込み、
 * ノートの参照をローカルの画像に書き換える。
 *
 * 元のポストが削除されると pbs.twimg.com の画像も消えるので、生きているうちに
 * 手元へ保存しておくためのもの。経緯は docs/notes/画像のローカル保存.md。
 *
 * やること:
 *   - 画像を <vault>/assets/twitter/<メディアID>.webp に保存(format=webp&name=large)
 *   - frontmatter の images / quoted_images を "[[assets/twitter/<ID>.webp]]" に置き換え、
 *     元の URL は image_urls / quoted_image_urls に移す
 *   - 本文の ![...](https://pbs.twimg.com/...) を ![[assets/twitter/<ID>.webp]] に置き換え
 *   - 404 / 403 で取れなかった画像は URL のまま残し、frontmatter に images_lost: true を付ける
 * 既存の本文・プロパティ(created/updated 等)はそのまま保持する。
 * 何度実行しても同じ結果になる(保存済みの画像は再取得しない)。
 *
 * 対象フォルダは環境変数 T2O_VAULT_DIR か --vault で指定する(必須)。
 * 拡張の保存先(既定 <vault>/Clippings/twitter)を絶対パスで渡すこと。
 * vault のルートは、対象フォルダから親をたどって .obsidian のある場所を使う。
 *
 * 使い方:
 *   export T2O_VAULT_DIR="$HOME/Documents/obsidian/Clippings/twitter"
 *   node scripts/localize-images.mjs                  # ドライラン(HEAD で生死だけ確認、書き込みなし)
 *   node scripts/localize-images.mjs --apply          # 実際に保存・書き換え
 *
 * 環境変数:
 *   T2O_VAULT_DIR   対象フォルダ(必須。--vault が優先)
 *   T2O_DELAY_MS    リクエスト間の待機ミリ秒(任意。既定 300)
 *   T2O_CONCURRENCY 同時リクエスト数(任意。既定 3)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APPLY = process.argv.includes("--apply");

const DELAY_MS = Number(process.env.T2O_DELAY_MS) > 0
  ? Number(process.env.T2O_DELAY_MS)
  : 300;
const CONCURRENCY = Number(process.env.T2O_CONCURRENCY) > 0
  ? Number(process.env.T2O_CONCURRENCY)
  : 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  node scripts/localize-images.mjs            # ドライラン
  node scripts/localize-images.mjs --apply    # 書き込み

または:
  node scripts/localize-images.mjs --vault <対象フォルダ> [--apply]`;

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

/** 親をたどって .obsidian のあるフォルダ(vault のルート)を探す */
async function findVaultRoot(dir) {
  let cur = dir;
  for (;;) {
    try {
      const s = await fs.stat(path.join(cur, ".obsidian"));
      if (s.isDirectory()) return cur;
    } catch {
      // 無ければ親へ
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// 画像として保存する pbs.twimg.com の URL(プロフィール画像などは対象外)
const PBS_RE =
  /https:\/\/pbs\.twimg\.com\/(?:media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/[^\s)"'\]>]+/g;

/** URL から、クエリと拡張子を落とした画像の基底 URL を作る */
function baseOf(url) {
  return url.split("?")[0].replace(/\.(?:jpe?g|png|webp|gif)$/i, "");
}

/** 保存ファイル名(画像サーバー側のメディアID + .webp) */
function fileNameOf(url) {
  return baseOf(url).split("/").pop() + ".webp";
}

/**
 * 画像 1 枚の状態を確かめ、--apply なら保存する。
 * 戻り値: "saved" | "exists" | "alive"(ドライラン) | "lost"(404/403) | "error"(一時的な失敗)
 */
async function fetchImage(url, destPath) {
  try {
    await fs.access(destPath);
    return "exists";
  } catch {
    // 未保存
  }

  const src = `${baseOf(url)}?format=webp&name=large`;
  let res;
  try {
    res = await fetch(src, { method: APPLY ? "GET" : "HEAD" });
  } catch {
    return "error";
  }
  if (res.status === 404 || res.status === 403) return "lost";
  if (!res.ok || !(res.headers.get("content-type") || "").startsWith("image/")) {
    return "error";
  }
  if (!APPLY) return "alive";

  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = destPath + ".tmp";
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, destPath);
  return "saved";
}

/** 並列数を絞って順に処理する */
async function runPool(items, worker) {
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
      await sleep(DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, run));
}

/** frontmatter と本文に分ける。frontmatter が無ければ fm は null */
function splitNote(text) {
  if (!text.startsWith("---\n")) return { fm: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { fm: null, body: text };
  return { fm: text.slice(4, end), body: text.slice(end + 5) };
}

/** frontmatter をトップレベルのキーごとのブロックに分ける(行単位、順序を保つ) */
function parseBlocks(fm) {
  const blocks = [];
  for (const line of fm.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (m) blocks.push({ key: m[1], lines: [line] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
    else blocks.push({ key: null, lines: [line] });
  }
  return blocks;
}

/** リストのブロックから項目の値を取り出す(前後のクォートは外す) */
function listItems(block) {
  return block.lines
    .slice(1)
    .map((l) => l.match(/^\s+-\s+(.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim().replace(/^"(.*)"$/, "$1"));
}

function listBlock(key, items) {
  return { key, lines: [`${key}:`, ...items.map((v) => `  - ${v}`)] };
}

const URL_KEYS = { images: "image_urls", quoted_images: "quoted_image_urls" };

/**
 * ノート 1 件を書き換える。
 * local: 画像 URL の基底 → vault 相対パス(保存済みのもの)
 * lost:  取れなかった画像の基底 URL の集合
 */
function rewriteNote(text, local, lost) {
  const { fm, body } = splitNote(text);
  const linkOf = (url) => local.get(baseOf(url));

  // 本文: 画像の埋め込みをローカルの埋め込みに置き換える
  const newBody = body.replace(/!\[[^\]]*\]\((https:\/\/pbs\.twimg\.com\/[^)\s]+)\)/g, (all, url) => {
    const p = linkOf(url);
    return p ? `![[${p}]]` : all;
  });

  if (fm === null) return newBody === body ? text : newBody;

  let blocks = parseBlocks(fm);
  let anyLost = false;

  for (const [key, urlKey] of Object.entries(URL_KEYS)) {
    const idx = blocks.findIndex((b) => b.key === key);
    if (idx < 0) continue;

    const items = listItems(blocks[idx]);
    const moved = [];
    const newItems = items.map((v) => {
      if (!v.startsWith("https://pbs.twimg.com/")) return v.startsWith("[[") ? `"${v}"` : v;
      if (lost.has(baseOf(v))) anyLost = true;
      const p = linkOf(v);
      if (!p) return v;
      moved.push(v);
      return `"[[${p}]]"`;
    });
    if (!moved.length) continue;

    // 元の URL は *_urls に集める(再実行時は既存分と合わせる)
    const oldIdx = blocks.findIndex((b) => b.key === urlKey);
    const kept = oldIdx >= 0 ? listItems(blocks[oldIdx]) : [];
    const urls = [...new Set([...kept, ...moved])];

    blocks[idx] = listBlock(key, newItems);
    blocks = blocks.filter((b) => b.key !== urlKey);
    const at = blocks.findIndex((b) => b.key === key);
    blocks.splice(at + 1, 0, listBlock(urlKey, urls));
  }

  // まだ URL のまま残っている画像に、取れなかったものがあるか
  for (const key of Object.keys(URL_KEYS)) {
    const b = blocks.find((x) => x.key === key);
    if (b && listItems(b).some((v) => lost.has(baseOf(v)))) anyLost = true;
  }
  blocks = blocks.filter((b) => b.key !== "images_lost");
  if (anyLost) {
    const at = blocks.findIndex((b) => b.key === "quoted_image_urls" || b.key === "quoted_images");
    const after = at >= 0 ? at : blocks.findIndex((b) => b.key === "image_urls" || b.key === "images");
    blocks.splice(after + 1, 0, { key: "images_lost", lines: ["images_lost: true"] });
  }

  const newFm = blocks.flatMap((b) => b.lines).join("\n");
  const out = `---\n${newFm}\n---\n${newBody}`;
  return out === text ? text : out;
}

async function main() {
  const vaultDir = await resolveVaultDir();
  const root = await findVaultRoot(vaultDir);
  if (!root) {
    console.error(`vault のルート(.obsidian のあるフォルダ)が見つかりません: ${vaultDir}`);
    process.exit(1);
  }
  const assetsDir = path.join(root, "assets", "twitter");
  const linkPrefix = path.relative(root, assetsDir).split(path.sep).join("/");

  const files = (await fs.readdir(vaultDir)).filter((f) => f.endsWith(".md"));
  const notes = [];
  const urlByBase = new Map();
  for (const f of files) {
    const p = path.join(vaultDir, f);
    const text = await fs.readFile(p, "utf8");
    const urls = text.match(PBS_RE) || [];
    if (!urls.length) continue;
    notes.push({ path: p, name: f, text, bases: [...new Set(urls.map(baseOf))] });
    for (const u of urls) if (!urlByBase.has(baseOf(u))) urlByBase.set(baseOf(u), u);
  }

  console.log(`${APPLY ? "[apply]" : "[dry-run]"} 対象ノート ${notes.length} 件 / 画像 ${urlByBase.size} 枚`);
  console.log(`保存先: ${assetsDir}`);
  if (APPLY) await fs.mkdir(assetsDir, { recursive: true });

  const status = new Map();
  const counts = { saved: 0, exists: 0, alive: 0, lost: 0, error: 0 };
  let done = 0;
  await runPool([...urlByBase.entries()], async ([base, url]) => {
    const s = await fetchImage(url, path.join(assetsDir, fileNameOf(url)));
    status.set(base, s);
    counts[s]++;
    if (++done % 50 === 0) console.log(`  ${done}/${urlByBase.size}`);
  });

  const local = new Map();
  const lost = new Set();
  for (const [base, s] of status) {
    if (s === "saved" || s === "exists" || s === "alive") {
      local.set(base, `${linkPrefix}/${fileNameOf(base)}`);
    } else if (s === "lost") {
      lost.add(base);
    }
  }

  let changed = 0;
  const lostNotes = [];
  for (const n of notes) {
    const out = rewriteNote(n.text, local, lost);
    if (n.bases.some((b) => lost.has(b))) lostNotes.push(n.name);
    if (out === n.text) continue;
    changed++;
    if (APPLY) {
      const tmp = n.path + ".tmp";
      await fs.writeFile(tmp, out, "utf8");
      await fs.rename(tmp, n.path);
    }
  }

  console.log("");
  console.log(`画像: 保存 ${counts.saved} / 保存済み ${counts.exists} / 取得可能(ドライラン) ${counts.alive} / 消失 ${counts.lost} / 一時エラー ${counts.error}`);
  console.log(`ノート: 書き換え${APPLY ? "" : "予定"} ${changed} 件 / 消えた画像を含む ${lostNotes.length} 件`);
  if (counts.error) console.log("一時エラーの画像は書き換えていません。時間をおいて再実行してください。");
  if (lostNotes.length) {
    console.log("\n消えた画像を含むノート:");
    for (const n of lostNotes.sort()) console.log(`  ${n}`);
  }
  if (!APPLY) console.log("\nドライランです。書き込むには --apply を付けて再実行してください。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
