// 公式Wiki（whiteoutsurvival.wiki / Century Games）から、英雄のID・名前・アイコンを集めて
// public/hero-db.json を作る。GitHub Actions から週1回程度実行する想定。
//
// IDの判定方法（裏付け）：
//   各英雄ページの専用装備画像 equipment_icon_10XXXXX.png の XXXXX、
//   またはスキル画像 hero_skill_icon_XXXXXn.png の XXXXX が、API の英雄ID と一致する。
//   （例：Wayne のページ → equipment_icon_1050031.png / hero_skill_icon_500311.png → ID 50031）

import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "public", "hero-db.json");
const BASE = "https://www.whiteoutsurvival.wiki";
const ICON_BASE = "https://gom-s3-user-avatar.s3.us-west-2.amazonaws.com/wp-content/uploads/";
const DELAY_MS = Number(process.env.HERO_DB_DELAY_MS ?? 1500); // Wiki に負担をかけないよう間隔をあける
const MAX_AGE_DAYS = Number(process.env.HERO_DB_MAX_AGE_DAYS ?? 7);
const FORCE = process.env.HERO_DB_FORCE === "1";
const SOURCE_HTML_DIR = process.env.HERO_DB_SOURCE_DIR; // テスト用：ローカルのHTMLを読む

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(url) {
  if (SOURCE_HTML_DIR) {
    const name = url.replace(BASE, "").replace(/[^a-z0-9]+/gi, "_") || "index";
    return fs.readFile(path.join(SOURCE_HTML_DIR, name + ".html"), "utf8");
  }
  const res = await fetch(url, {
    headers: { "User-Agent": "wos-data hero list builder (GitHub Actions; once a week)" },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// 英雄一覧ページから、各英雄ページのURLを集める
export function heroLinks(html) {
  const set = new Set();
  for (const m of html.matchAll(/href=["'](https:\/\/www\.whiteoutsurvival\.wiki)?\/heroes\/([a-z0-9-]+)\/?["']/gi)) {
    set.add(`${BASE}/heroes/${m[2].toLowerCase()}/`);
  }
  return [...set];
}

// 英雄ページ1つから情報を読み取る
export function parseHero(html, url) {
  const ids = [];
  const eq = html.match(/equipment_icon_10(5\d{4})\.png/i);
  if (eq) ids.push(eq[1]);
  // スキル画像の先頭5桁が英雄ID（最も多く出てくるものを採用）
  const count = new Map();
  for (const m of html.matchAll(/hero_skill_icon_(5\d{4})\d+\.png/gi)) count.set(m[1], (count.get(m[1]) || 0) + 1);
  const skillId = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (skillId) ids.push(skillId);
  const id = ids[0];
  if (!id) return null;
  // 専用装備とスキルでIDが食い違うページは誤判定の恐れがあるので記録しておく
  const conflict = eq && skillId && eq[1] !== skillId;

  const title = html.match(/<title>\s*([^<]+?)\s+-\s+Whiteout Survival Wiki/i)?.[1]?.trim();
  const jaHref = html.match(/href=["']https:\/\/www\.whiteoutsurvival\.wiki\/ja\/heroes\/([^"'/]+)\/?["']/i)?.[1];
  let ja = null;
  if (jaHref) {
    try { ja = decodeURIComponent(jaHref).replace(/-(\d+|ja)$/i, "").trim(); } catch { ja = null; }
    if (ja && /^[a-z0-9-]+$/i.test(ja)) ja = null; // 英字だけのスラッグは日本語名ではない
  }
  const rel = (u) => (u ? u.replace(ICON_BASE, "") : null);
  const hero = rel(
    html.match(/<img[^>]+alt=["']post_image["'][^>]+src=["']([^"']+)["']/i)?.[1] ||
    html.match(/<img[^>]+src=["']([^"']+)["'][^>]+alt=["']post_image["']/i)?.[1]
  );
  const gear = rel(html.match(/(https:\/\/[^"'\s)]+equipment_icon_10\d{5}\.png)/i)?.[1]);
  const cls = html.match(/\b(Infantry|Lancer|Marksm[ae]n)\b/i)?.[1] || null;
  const troop = cls ? ({ infantry: "Infantry", lancer: "Lancer", marksman: "Marksman", marksmen: "Marksman" })[cls.toLowerCase()] : null;
  return { id, en: title || null, ja, troop, icons: { hero, gear }, url, conflict: !!conflict };
}

async function main() {
  if (!FORCE) {
    const old = JSON.parse(await fs.readFile(OUT, "utf8").catch(() => "null"));
    const age = old?.updated_at ? (Date.now() - Date.parse(old.updated_at)) / 86400000 : Infinity;
    if (age < MAX_AGE_DAYS) { console.log(`英雄一覧: 更新から${age.toFixed(1)}日なのでスキップ`); return; }
  }
  const links = heroLinks(await getHtml(`${BASE}/heroes/`));
  console.log(`英雄一覧: ${links.length}ページ`);
  const heroes = {};
  const problems = [];
  for (const url of links) {
    await sleep(DELAY_MS);
    try {
      const h = parseHero(await getHtml(url), url);
      if (!h) { problems.push(`IDなし: ${url}`); continue; }
      if (h.conflict) problems.push(`ID食い違い: ${url}`);
      if (heroes[h.id]) { problems.push(`ID重複 ${h.id}: ${heroes[h.id].url} / ${url}`); continue; }
      heroes[h.id] = h;
    } catch (e) {
      problems.push(`取得失敗: ${url} (${e.message})`);
    }
  }
  const count = Object.keys(heroes).length;
  if (count < Number(process.env.HERO_DB_MIN ?? 10)) throw new Error(`英雄が${count}人しか取れませんでした（ページの形が変わった可能性）。前回のファイルを残します。`);
  const out = {
    updated_at: new Date().toISOString(),
    _source: "公式Wiki（whiteoutsurvival.wiki）の各英雄ページから自動作成。ID＝専用装備画像 equipment_icon_10XXXXX またはスキル画像 hero_skill_icon_XXXXXn の番号。日本語名＝同ページの日本語版リンク先の名前。画像の権利は Century Games にあります。",
    icon_base: ICON_BASE,
    heroes,
    problems,
  };
  await fs.writeFile(OUT, JSON.stringify(out, null, 1));
  console.log(`英雄一覧: ${count}人を保存（注意 ${problems.length}件）`);
  for (const p of problems) console.log("  - " + p);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
