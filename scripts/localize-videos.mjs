#!/usr/bin/env node
/**
 * 保存済みの動画ツイート(.md)の動画を vault に取り込み、ノートの <iframe> を
 * ローカルの動画の埋め込みに置き換える。
 *
 * NAS-61 で拡張が新しく保存するノートは動画を取り込むようになった。これは
 * それより前に保存したノートを同じ形に揃えるためのもの。経緯は
 * docs/notes/動画のローカル保存.md。
 *
 * 対象: 「Watch Video on X」を含むノート(対象フォルダ以下を再帰的に探す)
 * やること:
 *   - source: のツイート ID で fxtwitter API を引き、拡張と同じ規則(高さ 720 以下で
 *     いちばん高い mp4、30MB 以下)で <vault>/assets/twitter/<メディアID>.mp4 に保存
 *   - frontmatter に videos:(引用元の動画は quoted_videos:)を足し、
 *     本文の <iframe> を ![[assets/twitter/<ID>.mp4]] に置き換える。
 *     引用元の動画は、引用部分の「Watch Video on X」の行の下に埋め込む
 *   - 消えた動画(API にない・404/403)は <iframe> のまま残し、videos_lost: true を付ける
 *   - 30MB を超える動画は <iframe> のまま残し、印は付けない(拡張と同じ扱い)
 *   - images: に動画サムネイル(*_video_thumb)が無いノートは、fxtwitter の thumbnail_url を
 *     webp で assets/twitter/ に保存し、images: と image_urls: に足す(本文には足さない)
 * 既存の本文・プロパティはそのまま保持する。
 * 何度実行しても同じ結果になる(保存済みのファイルは再取得しない)。
 *
 * 使い方:
 *   export T2O_VAULT_DIR="$HOME/Documents/obsidian/Clippings"
 *   node scripts/localize-videos.mjs                  # ドライラン(API と HEAD だけ、書き込みなし)
 *   node scripts/localize-videos.mjs --apply          # 実際に保存・書き換え
 *
 * 環境変数:
 *   T2O_VAULT_DIR   対象フォルダ(必須。--vault が優先)
 *   T2O_DELAY_MS    リクエスト間の待機ミリ秒(任意。既定 300)
 *   T2O_CONCURRENCY 同時に処理するノート数(任意。既定 2)
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
  : 2;

// background.js と同じ規則
const MAX_VIDEO_HEIGHT = 720;
const MAX_VIDEO_BYTES = 30 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function expandHome(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function parseVaultArg(argv) {
  const eq = argv.find((a) => a.startsWith("--vault="));
  if (eq) return eq.slice("--vault=".length);
  const i = argv.indexOf("--vault");
  if (i >= 0) return argv[i + 1];
  return undefined;
}

const USAGE = `対象フォルダが指定されていません。

  export T2O_VAULT_DIR="$HOME/Documents/obsidian/Clippings"
  node scripts/localize-videos.mjs            # ドライラン
  node scripts/localize-videos.mjs --apply    # 書き込み

または:
  node scripts/localize-videos.mjs --vault <対象フォルダ> [--apply]`;

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

async function listNotes(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listNotes(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// ---- 動画の選び方(background.js の pickVideoVariant / videoMediaId と同じ) ----

function variantHeight(url) {
  const m = url.match(/\/(\d+)x(\d+)\//);
  return m ? Number(m[2]) : null;
}

function pickVideoVariant(video) {
  const mp4s = (video?.variants || []).filter(
    (v) => v.content_type === "video/mp4" && v.url
  );
  if (mp4s.length === 0) return video?.url || null;
  const sized = mp4s.map((v) => ({ ...v, h: variantHeight(v.url) }));
  const known = sized.filter((v) => v.h !== null);
  if (known.length === 0) {
    return sized.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0].url;
  }
  const fits = known.filter((v) => v.h <= MAX_VIDEO_HEIGHT);
  if (fits.length > 0) {
    return fits.sort((a, b) => b.h - a.h || (b.bitrate || 0) - (a.bitrate || 0))[0].url;
  }
  return known.sort((a, b) => a.h - b.h)[0].url;
}

function videoMediaId(url) {
  const p = url.split("?")[0];
  const m = p.match(/\/(?:ext_tw_video|amplify_video)\/(\d+)\//);
  if (m) return m[1];
  const t = p.match(/\/tweet_video\/([^/]+)\.mp4$/);
  return t ? t[1] : null;
}

// ---- サムネイル(localize-images.mjs と同じ名前の付け方) ----

function imageBase(url) {
  return url.split("?")[0].replace(/\.(?:jpe?g|png|webp|gif)$/i, "");
}

function thumbFileName(url) {
  return imageBase(url).split("/").pop() + ".webp";
}

// ---- 取得 ----

/**
 * fxtwitter の tweet オブジェクト。
 * 戻り値: { tweet } | { lost: true }(404 など、ポストが無い) | { error: true }
 */
async function lookupTweet(tweetId) {
  let res;
  try {
    res = await fetch(`https://api.fxtwitter.com/status/${tweetId}`, {
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { error: true };
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) return { lost: true };
  if (!res.ok) return { error: true };
  try {
    const json = await res.json();
    return json.tweet ? { tweet: json.tweet } : { lost: true };
  } catch {
    return { error: true };
  }
}

/**
 * mp4 を 1 本保存する(ドライランは HEAD で大きさだけ見る)。
 * 戻り値: "saved" | "exists" | "alive" | "toobig" | "lost" | "error"
 */
async function fetchVideo(url, destPath) {
  try {
    await fs.access(destPath);
    return "exists";
  } catch {
    // 未保存
  }
  let res;
  try {
    res = await fetch(url, { method: APPLY ? "GET" : "HEAD" });
  } catch {
    return "error";
  }
  if (res.status === 404 || res.status === 403) return "lost";
  if (!res.ok) return "error";
  const length = Number(res.headers.get("content-length") || 0);
  if (length > MAX_VIDEO_BYTES) {
    res.body?.cancel();
    return "toobig";
  }
  if (!APPLY) return "alive";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_VIDEO_BYTES) return "toobig";
  const tmp = destPath + ".tmp";
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, destPath);
  return "saved";
}

/** サムネイルを webp で保存する。戻り値は fetchVideo と同じ(toobig なし) */
async function fetchThumb(url, destPath) {
  try {
    await fs.access(destPath);
    return "exists";
  } catch {
    // 未保存
  }
  let res;
  try {
    res = await fetch(`${imageBase(url)}?format=webp&name=large`, {
      method: APPLY ? "GET" : "HEAD",
    });
  } catch {
    return "error";
  }
  if (res.status === 404 || res.status === 403) return "lost";
  if (!res.ok || !(res.headers.get("content-type") || "").startsWith("image/")) return "error";
  if (!APPLY) return "alive";
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = destPath + ".tmp";
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, destPath);
  return "saved";
}

// ---- frontmatter(localize-images.mjs と同じ行単位の扱い) ----

function splitNote(text) {
  if (!text.startsWith("---\n")) return { fm: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { fm: null, body: text };
  return { fm: text.slice(4, end), body: text.slice(end + 5) };
}

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

function listItems(block) {
  return block.lines
    .slice(1)
    .map((l) => l.match(/^\s+-\s+(.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim().replace(/^"(.*)"$/, "$1"));
}

function listBlock(key, items) {
  return { key, lines: [`${key}:`, ...items] };
}

/** keys のうち最後に現れるブロックの直後に block を差し込む(どれも無ければ末尾) */
function insertAfter(blocks, keys, block) {
  let at = -1;
  blocks.forEach((b, i) => {
    if (keys.includes(b.key)) at = i;
  });
  if (at < 0) blocks.push(block);
  else blocks.splice(at + 1, 0, block);
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- ノート 1 件 ----

function readNote(text) {
  const { fm } = splitNote(text);
  if (fm === null) return null;
  const source = (fm.match(/^source:\s*(\S+)/m) || [])[1];
  const quotedSource = (fm.match(/^quoted_source:\s*(\S+)/m) || [])[1];
  const tweetId = source && (source.match(/\/status\/(\d+)/) || [])[1];
  if (!tweetId) return null;
  const watch = (url) => url && text.includes(`Watch Video on X](${url})`);
  const blocks = parseBlocks(fm);
  const has = (k) => blocks.some((b) => b.key === k);
  return {
    source,
    quotedSource,
    tweetId,
    // 本文の <iframe> を置き換える対象か
    needMain: watch(source) && text.includes(`<iframe src="${source}"`) && !has("videos"),
    // 引用部分に動画の埋め込みを足す対象か
    needQuoted: !!quotedSource && watch(quotedSource) && !has("quoted_videos"),
    needThumb: !/_video_thumb\//.test(fm),
  };
}

/**
 * 書き換え後のテキストを返す。
 * r: { main: [path], quoted: [path], thumbs: [{ local, url }], lost: bool }
 */
function rewriteNote(text, info, r) {
  const { fm, body } = splitNote(text);
  let newBody = body;

  if (r.main.length) {
    const re = new RegExp(`<iframe src="${escRe(info.source)}"[^>]*></iframe>`);
    newBody = newBody.replace(re, r.main.map((p) => `![[${p}]]`).join("\n"));
  }
  if (r.quoted.length) {
    const line = `🎥 [Watch Video on X](${info.quotedSource})`;
    const at = newBody.lastIndexOf(line);
    if (at >= 0) {
      const end = at + line.length;
      const embeds = r.quoted.map((p) => `![[${p}]]`).join("\n");
      newBody = `${newBody.slice(0, end)}\n${embeds}${newBody.slice(end)}`;
    }
  }

  let blocks = parseBlocks(fm);

  if (r.thumbs.length) {
    const quote = (v) => (v.startsWith("[[") ? `  - "${v}"` : `  - ${v}`);
    const imgIdx = blocks.findIndex((b) => b.key === "images");
    const images = imgIdx >= 0 ? listItems(blocks[imgIdx]) : [];
    const newImages = listBlock("images", [
      ...images.map(quote),
      ...r.thumbs.map((t) => `  - "[[${t.local}]]"`),
    ]);
    if (imgIdx >= 0) blocks[imgIdx] = newImages;
    else insertAfter(blocks, ["date", "text", "author", "source"], newImages);

    const urlIdx = blocks.findIndex((b) => b.key === "image_urls");
    const urls = urlIdx >= 0 ? listItems(blocks[urlIdx]) : [];
    const newUrls = listBlock("image_urls", [
      ...urls.map((u) => `  - ${u}`),
      ...r.thumbs.map((t) => `  - ${t.url}`),
    ]);
    if (urlIdx >= 0) blocks[urlIdx] = newUrls;
    else insertAfter(blocks, ["images"], newUrls);
  }

  if (r.main.length) {
    insertAfter(blocks, ["date", "images", "image_urls"],
      listBlock("videos", r.main.map((p) => `  - "[[${p}]]"`)));
  }
  if (r.quoted.length) {
    insertAfter(blocks, ["quoted_source", "quoted_images", "quoted_image_urls"],
      listBlock("quoted_videos", r.quoted.map((p) => `  - "[[${p}]]"`)));
  }
  if (r.lost && !blocks.some((b) => b.key === "videos_lost")) {
    insertAfter(blocks, ["date", "images", "image_urls", "videos"],
      { key: "videos_lost", lines: ["videos_lost: true"] });
  }

  const out = `---\n${blocks.flatMap((b) => b.lines).join("\n")}\n---\n${newBody}`;
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

  const notes = [];
  for (const p of await listNotes(vaultDir)) {
    const text = await fs.readFile(p, "utf8");
    if (!text.includes("Watch Video on X")) continue;
    const info = readNote(text);
    if (!info) continue;
    notes.push({ path: p, name: path.relative(vaultDir, p), text, info });
  }
  const todo = notes.filter((n) => n.info.needMain || n.info.needQuoted || n.info.needThumb);

  console.log(`${APPLY ? "[apply]" : "[dry-run]"} 動画ツイートのノート ${notes.length} 件 / 処理が要るもの ${todo.length} 件`);
  console.log(`保存先: ${assetsDir}`);
  if (APPLY) await fs.mkdir(assetsDir, { recursive: true });

  const counts = { saved: 0, exists: 0, alive: 0, toobig: 0, lost: 0, error: 0 };
  const thumbCounts = { saved: 0, exists: 0, alive: 0, lost: 0, error: 0 };
  const report = { lost: [], toobig: [], error: [], noMainVideo: [] };
  let changed = 0;
  let bytes = 0;

  let i = 0;
  const run = async () => {
    while (i < todo.length) {
      const n = todo[i++];
      await processNote(n);
      await sleep(DELAY_MS);
    }
  };

  async function saveVideos(videos) {
    const paths = [];
    let lost = false;
    let toobig = false;
    let error = false;
    for (const v of videos) {
      const url = pickVideoVariant(v);
      const id = url && videoMediaId(url);
      if (!id) {
        lost = true;
        continue;
      }
      const file = `${id}.mp4`;
      const s = await fetchVideo(url, path.join(assetsDir, file));
      counts[s]++;
      if (s === "saved") bytes += (await fs.stat(path.join(assetsDir, file))).size;
      if (s === "saved" || s === "exists" || s === "alive") {
        const p = `${linkPrefix}/${file}`;
        if (!paths.includes(p)) paths.push(p);
      } else if (s === "lost") lost = true;
      else if (s === "toobig") toobig = true;
      else error = true;
    }
    return { paths, lost, toobig, error };
  }

  async function processNote(n) {
    const { info } = n;
    const r = { main: [], quoted: [], thumbs: [], lost: false };
    const looked = await lookupTweet(info.tweetId);
    if (looked.error) {
      report.error.push(n.name);
      return;
    }
    const tweet = looked.tweet;
    const mainVideos = tweet?.media?.videos || [];
    const quotedVideos = tweet?.quote?.media?.videos || [];
    let error = false;

    if (info.needMain) {
      if (looked.lost) r.lost = true;
      else if (mainVideos.length === 0) {
        // 本体に動画が無く、引用元にだけある(拡張が引用元の動画を本体の動画と取り違えた)
        if (quotedVideos.length) {
          report.noMainVideo.push(n.name);
        } else r.lost = true;
      } else {
        const s = await saveVideos(mainVideos);
        r.main = s.paths;
        if (s.lost && !s.paths.length) r.lost = true;
        if (s.toobig) report.toobig.push(n.name);
        error ||= s.error;
      }
    }
    if (info.needQuoted && !looked.lost && quotedVideos.length) {
      const s = await saveVideos(quotedVideos);
      r.quoted = s.paths;
      if (s.toobig) report.toobig.push(`${n.name}(引用元)`);
      error ||= s.error;
    }
    if (info.needThumb && !looked.lost) {
      for (const v of [...mainVideos, ...quotedVideos]) {
        // 投稿者が付けたサムネイルは media/ にあり、_video_thumb を含まない
        const url = v.thumbnail_url;
        if (!url || !url.startsWith("https://pbs.twimg.com/")) continue;
        const file = thumbFileName(url);
        if (n.text.includes(imageBase(url).split("/").pop())) continue;
        const s = await fetchThumb(url, path.join(assetsDir, file));
        thumbCounts[s]++;
        if (s === "saved" || s === "exists" || s === "alive") {
          r.thumbs.push({ local: `${linkPrefix}/${file}`, url: `${imageBase(url)}?format=jpg&name=large` });
        } else if (s === "error") error = true;
      }
    }

    if (r.lost) report.lost.push(n.name);
    if (error) report.error.push(n.name);
    const out = rewriteNote(n.text, info, r);
    if (out === n.text) return;
    changed++;
    if (APPLY) {
      const tmp = n.path + ".tmp";
      await fs.writeFile(tmp, out, "utf8");
      await fs.rename(tmp, n.path);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, run));

  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log("");
  console.log(`動画: 保存 ${counts.saved}(${mb(bytes)}MB) / 保存済み ${counts.exists} / 取得可能(ドライラン) ${counts.alive} / 30MB 超 ${counts.toobig} / 消失 ${counts.lost} / 一時エラー ${counts.error}`);
  console.log(`サムネイル: 保存 ${thumbCounts.saved} / 保存済み ${thumbCounts.exists} / 取得可能(ドライラン) ${thumbCounts.alive} / 消失 ${thumbCounts.lost} / 一時エラー ${thumbCounts.error}`);
  console.log(`ノート: 書き換え${APPLY ? "" : "予定"} ${changed} 件`);
  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title}(${list.length} 件):`);
    for (const x of [...new Set(list)].sort()) console.log(`  ${x}`);
  };
  show("消えた動画(videos_lost: true)", report.lost);
  show("30MB を超えて保存しなかった動画", report.toobig);
  show("本体に動画が無く、引用元にだけあるノート(本体の <iframe> は残す)", report.noMainVideo);
  show("一時エラー(時間をおいて再実行してください)", report.error);
  if (!APPLY) console.log("\nドライランです。書き込むには --apply を付けて再実行してください。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
