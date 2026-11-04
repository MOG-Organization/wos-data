// Whiteout Stats API からデータを取得して public/data/ に保存する
// GitHub Actions から毎日1回実行される想定。
// 必要な環境変数: WOS_API_KEY（GitHub の Secrets に保存）

import fs from "node:fs/promises";
import path from "node:path";

const API_BASE = process.env.WOS_API_BASE || "https://api.whiteoutstats.com/v1";
const API_KEY = process.env.WOS_API_KEY;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "public", "data");
const HIST = path.join(ROOT, "history", "svs"); // SvS 履歴はやり直しがきかないのでリポジトリに保存する
const MIN_INTERVAL_MS = Number(process.env.WOS_MIN_INTERVAL_MS ?? 1050); // 毎分60回の制限に合わせる

if (!API_KEY) {
  console.error("WOS_API_KEY が設定されていません。GitHub の Settings > Secrets に登録してください。");
  process.exit(1);
}

const config = JSON.parse(await fs.readFile(path.join(ROOT, "config.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- API 呼び出し（回数管理つき） ----------
let budget = 0;
let calls = 0;
let lastCallAt = 0;
class BudgetExhausted extends Error {}

async function api(pathAndQuery, { counted = true } = {}) {
  if (counted && budget <= 0) throw new BudgetExhausted("本日の回数枠の上限に達しました");
  for (let attempt = 0; attempt < 5; attempt++) {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const res = await fetch(API_BASE + pathAndQuery, {
      headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(150000), // プレイヤー情報は API 側で最大90秒待つことがある
    });
    if (counted) { calls++; budget--; }
    if (res.status === 429) {
      const dayLeft = Number(res.headers.get("X-RateLimit-Remaining-Day"));
      if (dayLeft === 0) throw new BudgetExhausted("API側で1日の上限に達しました");
      const reset = Number(res.headers.get("X-RateLimit-Reset-Minute"));
      const ms = reset ? Math.max(1000, reset * 1000 - Date.now() + 500) : 61000;
      console.warn(`429: ${Math.round(ms / 1000)}秒待って再試行 (${pathAndQuery})`);
      await sleep(ms);
      continue;
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status >= 500 && attempt < 4) { await sleep(5000); continue; }
      throw new Error(`HTTP ${res.status} ${pathAndQuery} ${text.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error(`再試行の上限に達しました: ${pathAndQuery}`);
}

// ---------- 応答の形の違いを吸収するヘルパー ----------
function firstArray(obj, keys) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object") return [];
  for (const k of keys) if (Array.isArray(obj[k])) return obj[k];
  for (const v of Object.values(obj)) if (Array.isArray(v) && v.length && typeof v[0] === "object") return v;
  return [];
}

const STATE_FIELDS = [
  "kid", "name", "player_count", "located", "active_7d", "alliance_count", "age_days", "opened_on",
  "power", "avg_power", "power_rank", "activity_rank", "health", "power_gain_7d", "state_transfer_score",
  "gov_power", "alliance_power", "labyrinth", "banner_url",
];
const pick = (o, fields) => Object.fromEntries(fields.filter((f) => o?.[f] !== undefined).map((f) => [f, o[f]]));

async function writeJSON(rel, data) {
  const file = path.join(DATA, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
}
async function readJSON(rel, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(DATA, rel), "utf8")); } catch { return fallback; }
}
const safeTag = (tag) => encodeURIComponent(tag).replace(/%/g, "_");

// ---------- 保存容量を抑えるため、サイトで使う項目だけ残す ----------
// API の王国詳細は 1 件 600KB 前後あり、全王国分だと GitHub Pages の上限(1GB)を超えるため
const KEEP_BOARDS = new Set([
  "alliance_power", "personal_power",
  "labyrinth", "land_of_heroes", "cave_of_monsters", "charm_mine", "research_center", "gear_forge", "gaia_heart",
]);
const ALLIANCE_ROW = ["rank", "abbr", "name", "score", "member_count", "leader_name"];
const PLAYER_ROW = ["rank", "uid", "nick_name", "alliance_abbr", "score", "score_label"];
function trimBoards(boards) {
  if (!boards) return null;
  const list = Array.isArray(boards) ? boards : Object.entries(boards).map(([key, v]) => ({ key, ...(Array.isArray(v) ? { rows: v } : v) }));
  return list
    .filter((b) => KEEP_BOARDS.has(b.key))
    .map((b) => ({
      key: b.key,
      rows: firstArray(b, ["rows", "entries", "items", "ranks"]).map((r) => pick(r, b.kind === "alliance" || b.key === "alliance_power" ? ALLIANCE_ROW : PLAYER_ROW)),
    }))
    .filter((b) => b.rows.length);
}
function trimState(state) {
  const { boards, board_totals, ...rest } = state || {};
  return rest;
}

// ---------- 本体 ----------
const now = new Date().toISOString();
const meta = await readJSON("meta.json", {});
const log = [];

// 以前の版で保存した大きいファイルを、必要な項目だけに縮める（API 呼び出しなし）
{
  const dir = path.join(DATA, "states");
  let shrunk = 0;
  for (const f of await fs.readdir(dir).catch(() => [])) {
    if (!f.endsWith(".json")) continue;
    const file = path.join(dir, f);
    const text = await fs.readFile(file, "utf8");
    if (!text.includes("avatar_url") && !text.includes("board_totals")) continue;
    const d = JSON.parse(text);
    await fs.writeFile(file, JSON.stringify({ updated_at: d.updated_at, state: trimState(d.state), boards: trimBoards(d.boards) }));
    shrunk++;
  }
  if (shrunk) console.log(`既存の王国ファイルを縮小: ${shrunk}件`);
}

const usage = await api("/usage", { counted: false });
const remaining = usage?.daily?.remaining ?? 5000;
budget = Math.max(0, remaining - (config.daily_safety_margin ?? 300));
console.log(`本日の残り回数: ${remaining}（今回使える上限: ${budget}）`);

try {
  // 1) 王国一覧（全王国）
  let states = [];
  let size = config.list_page_size || 100;
  for (let page = 1; page < 1000; page++) {
    let body = await api(`/states?page=${page}&size=${size}`).catch(async (e) => {
      if (page === 1 && size !== 24 && /HTTP 4\d\d/.test(e.message)) {
        console.warn(`size=${size} が使えないため 24 に切り替えます`);
        size = 24;
        return api(`/states?page=1&size=24`);
      }
      throw e;
    });
    const rows = firstArray(body, ["states", "items", "data", "results"]);
    if (!rows.length) break;
    states.push(...rows.map((s) => pick(s, STATE_FIELDS)));
    const totalPages = body?.pages ?? body?.total_pages ?? body?.pagination?.pages;
    if (totalPages && page >= totalPages) break;
    if (rows.length < size) break;
  }
  const byKid = new Map(states.filter((s) => s.kid != null).map((s) => [Number(s.kid), s]));
  states = [...byKid.values()].sort((a, b) => Number(a.kid) - Number(b.kid));
  if (states.length) {
    await writeJSON("states.json", { updated_at: now, states });
    log.push(`王国一覧: ${states.length}件`);
  }

  // 2) 王国の詳細を取る関数
  const lang = await readJSON("lang.json", { states: {} });
  globalThis.__lang = lang;
  const rotation = await readJSON("rotation.json", { next: 0 });
  globalThis.__rotation = rotation;
  const allKids = states.map((s) => Number(s.kid));
  const watch = (config.watch_states || []).map(Number);
  let detailDone = 0;
  async function fetchState(kid) {
    const body = await api(`/states/${kid}?include=boards&limit=100`);
    if (!body) return null;
    const state = body.state ?? body;
    const boards = body.boards ?? state.boards ?? null;
    await writeJSON(`states/${kid}.json`, { updated_at: now, state: trimState(state), boards: trimBoards(boards) });
    const jp = japaneseShare(boardRows(boards, "personal_power").map((r) => r.nick_name));
    if (jp || state.banner_url) lang.states[kid] = { ...(jp || {}), banner: state.banner_url ?? null, at: now.slice(0, 10) };
    detailDone++;
    return boards;
  }

  // 2-a) 監視中の王国を最優先で取得
  const stateAlliances = new Map(); // kid -> 上位同盟タグ
  for (const kid of watch) {
    const boards = await fetchState(kid);
    stateAlliances.set(kid, topAllianceTags(boards, config.top_alliances_per_watched_state ?? 10));
  }

  // 3) 同盟（指定した同盟＋監視王国の上位同盟）も先に取得
  const targets = [...(config.watch_alliances || [])].map((a) => ({ kid: Number(a.kid), tag: String(a.tag) }));
  for (const [kid, tags] of stateAlliances) for (const tag of tags) {
    if (!targets.some((t) => t.kid === kid && t.tag === tag)) targets.push({ kid, tag });
  }
  const allianceIndex = await readJSON("alliances/index.json", { alliances: [] });
  let allianceDone = 0;
  try {
    for (const { kid, tag } of targets) {
      const body = await api(`/alliances/${kid}/${encodeURIComponent(tag)}?include=info,roster`);
      if (!body) { console.warn(`同盟が見つかりません: ${kid} ${tag}`); continue; }
      const alliance = body.alliance ?? body.info ?? body;
      const members = firstArray(body.members ?? body.roster ?? body, ["members", "roster"]).map((m) => {
      const { avatar_url, ...rest } = m || {};
      return rest;
    });
      await writeJSON(`alliances/${kid}/${safeTag(tag)}.json`, { updated_at: now, alliance: { ...alliance, members: undefined }, members });
      const entry = { kid, tag, name: alliance.name ?? tag, power: alliance.power ?? null, count: alliance.count ?? members.length, updated_at: now };
      allianceIndex.alliances = allianceIndex.alliances.filter((a) => !(a.kid === kid && a.tag === tag));
      allianceIndex.alliances.push(entry);
      allianceDone++;
    }
  } finally {
    await writeJSON("alliances/index.json", allianceIndex);
    log.push(`同盟: ${allianceDone}件`);
  }

  // 4) SvS（Frosty キーのみ）。準備期間の点数をシーズンごとに記録
  try { await recordSvs(); }
  catch (e) { if (e instanceof BudgetExhausted) throw e; console.error(e); log.push(`SvS: エラー ${e.message}`); }

  // 5) 英雄（闘技場の防衛編成）：対象王国の地底探検上位の人だけ（1人1回）
  try { await recordHeroes(fetchState); }
  catch (e) { if (e instanceof BudgetExhausted) throw e; console.error(e); log.push(`英雄: エラー ${e.message}`); }

  // 2-b) その他の王国は残り回数の範囲で順番に（次回は続きから）
  try {
    const perRun = config.detail_per_run ?? 1200;
    const idx = rotation.next % Math.max(1, allKids.length);
    for (let i = 0; i < Math.min(perRun, allKids.length); i++) {
      const pos = (idx + i) % allKids.length;
      if (watch.includes(allKids[pos])) continue;
      await fetchState(allKids[pos]);
      rotation.next = (pos + 1) % allKids.length;
    }
  } finally {
    log.push(`王国詳細: ${detailDone}件`);
  }
} catch (e) {
  if (e instanceof BudgetExhausted) log.push(`途中終了: ${e.message}（続きは次回）`);
  else { console.error(e); process.exitCode = 1; log.push(`エラー: ${e.message}`); }
}

// 名前にひらがな・カタカナが入っている割合（日本人の多さの目安）
function japaneseShare(names) {
  const list = names.filter((n) => typeof n === "string" && n.trim());
  if (list.length < 10) return null;
  const kana = /[\u3041-\u309F\u30A1-\u30FF\uFF66-\uFF9F]/;
  const jp = list.filter((n) => kana.test(n)).length;
  return { jp: Math.round((jp / list.length) * 100), n: list.length };
}

// ---------- SvS ----------
async function recordSvs() {
  let body;
  try { body = await api("/svs/matchups"); }
  catch (e) {
    if (/HTTP 403/.test(e.message)) { log.push("SvS: Frosty のキーではないためスキップ"); return; }
    throw e;
  }
  const season = body?.season ?? body?.current_season;
  const pairsRaw = firstArray(body, ["matchups", "pairs", "items", "data"]);
  if (!season || !pairsRaw.length) { log.push("SvS: 今シーズンの対戦表がありません"); return; }
  meta.svs_sample = pairsRaw[0]; // 応答の形の確認用

  const kidOf = (v) => (v == null ? null : typeof v === "object" ? Number(v.kid ?? v.id) || null : Number(v) || null);
  const file = path.join(HIST, `season-${season}.json`);
  const hist = JSON.parse(await fs.readFile(file, "utf8").catch(() => "null")) || { season, pairs: {} };
  hist.stage = body.stage ?? hist.stage;
  hist.updated_at = now;
  let done = 0, skipped = 0;
  try {
    for (const p of pairsRaw) {
      const a = kidOf(p.state ?? p.a ?? p.kid ?? p.state_a ?? p.home);
      const b = kidOf(p.opponent ?? p.b ?? p.opponent_kid ?? p.state_b ?? p.away);
      if (!a) continue;
      const key = b ? `${Math.min(a, b)}-${Math.max(a, b)}` : `${a}-bye`;
      const prev = hist.pairs[key];
      if (prev?.final || prev?.bye) { skipped++; continue; } // 確定済みは取り直さない
      if (!b || p.bye) { hist.pairs[key] = { a, b: null, bye: true }; continue; }
      const sc = await api(`/states/${a}/svs/scores`); // 片方の王国だけで両方の点数が分かる
      if (!sc) { hist.pairs[key] = prev || { a, b }; continue; } // まだ点数が出ていない
      const days = firstArray(sc, ["days"]).map((d) => ({ day: d.day, status: d.status, a: d.state_score, b: d.opponent_score }));
      hist.pairs[key] = {
        a: Number(sc.state ?? a), b: Number(sc.opponent ?? b),
        score_a: sc.score ?? null, score_b: sc.opponent_score ?? null, stage: sc.stage ?? null, days,
        final: days.length >= 5 && days.every((d) => /ended/i.test(d.status || "")),
      };
      done++;
    }
  } finally {
    await fs.mkdir(HIST, { recursive: true });
    await fs.writeFile(file, JSON.stringify(hist));
    log.push(`SvS: シーズン${season} ${done}組を更新（確定済み${skipped}組はスキップ）`);
  }
}

// ---------- 英雄（闘技場の防衛編成） ----------
async function latestSvsOpponents(kids) {
  const files = (await fs.readdir(HIST).catch(() => [])).filter((f) => /^season-\d+\.json$/.test(f));
  if (!files.length) return [];
  const latest = files.sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]))[0];
  const h = JSON.parse(await fs.readFile(path.join(HIST, latest), "utf8"));
  const out = [];
  for (const r of Object.values(h.pairs)) {
    if (r.bye) continue;
    if (kids.includes(r.a)) out.push(r.b);
    if (kids.includes(r.b)) out.push(r.a);
  }
  return out;
}
function trimHero(h) {
  return {
    ...pick(h, ["id", "name", "level", "star", "stars", "star_label", "quality", "power", "icon", "position", "exclusive_gear_level"]),
    skill_levels: (h.skill_levels || []).map((x) => pick(x, ["id", "level"])),
    exclusive_gear: h.exclusive_gear ? pick(h.exclusive_gear, ["name", "level"]) : null,
    gear: (h.gear || []).map((g) => pick(g, ["slot", "name", "enhancement_level", "refine_level", "quality_label", "red", "troop_label"])),
  };
}
async function recordHeroes(fetchState) {
  const topN = config.hero_top_n ?? 10;
  const targets = [...new Set([
    ...(config.hero_states || []).map(Number),
    ...(config.hero_svs_opponent ? await latestSvsOpponents((config.watch_states || []).map(Number)) : []),
  ])].filter(Boolean);
  if (!targets.length) return;
  let players = 0;
  for (const kid of targets) {
    let d = await readJSON(`states/${kid}.json`, null);
    if (!d) { await fetchState(kid); d = await readJSON(`states/${kid}.json`, null); } // 対戦相手などで未取得なら取る
    const lab = (d?.boards || []).find((b) => b.key === "labyrinth")?.rows || [];
    const picked = lab.filter((r) => r.alliance_abbr && r.uid != null).slice(0, topN); // 同盟情報がある人だけ
    const out = [];
    try {
      for (const r of picked) {
        const body = await api(`/players/${r.uid}?id_type=uid&include=base,heroes`);
        const p = body?.player;
        if (!p) continue;
        out.push({
          uid: r.uid, nick_name: p.nick_name ?? r.nick_name, avatar_url: p.avatar_url ?? null,
          alliance: p.alliance ? pick(p.alliance, ["abbr", "name", "rank_label"]) : { abbr: r.alliance_abbr },
          power: p.power ?? null, furnace_level: p.furnace_level ?? null,
          labyrinth_rank: r.rank, labyrinth: r.score,
          heroes: firstArray(body.heroes ?? p.heroes, ["heroes", "team", "items"]).map(trimHero),
        });
        players++;
      }
    } finally {
      if (out.length) await writeJSON(`heroes/${kid}.json`, { updated_at: now, kid, players: out });
    }
  }
  log.push(`英雄: ${targets.length}王国 ${players}人`);
}

// 履歴（シーズンごとのファイル）から、王国ごとの表示用ファイルを作る（API 呼び出しなし）
async function buildSvsPages() {
  const files = (await fs.readdir(HIST).catch(() => [])).filter((f) => /^season-\d+\.json$/.test(f));
  if (!files.length) return;
  const perState = new Map();
  const seasons = [];
  for (const f of files) {
    const h = JSON.parse(await fs.readFile(path.join(HIST, f), "utf8"));
    seasons.push({ season: h.season, stage: h.stage, updated_at: h.updated_at, pairs: Object.keys(h.pairs).length });
    for (const r of Object.values(h.pairs)) {
      const sides = r.bye ? [[r.a, null, false]] : [[r.a, r.b, false], [r.b, r.a, true]];
      for (const [own, opp, flip] of sides) {
        if (!own) continue;
        const e = r.bye ? { season: h.season, bye: true } : {
          season: h.season, opponent: opp, final: !!r.final,
          score: flip ? r.score_b : r.score_a, opponent_score: flip ? r.score_a : r.score_b,
          days: (r.days || []).map((d) => ({ day: d.day, status: d.status, own: flip ? d.b : d.a, opp: flip ? d.a : d.b })),
        };
        if (!perState.has(own)) perState.set(own, []);
        perState.get(own).push(e);
      }
    }
  }
  for (const [kid, list] of perState) {
    list.sort((x, y) => y.season - x.season);
    await writeJSON(`svs/${kid}.json`, list);
  }
  seasons.sort((x, y) => y.season - x.season);
  await writeJSON("svs/index.json", { seasons });
}

function topAllianceTags(boards, n) {
  const rows = boardRows(boards, "alliance_power");
  return rows.map((r) => r.abbr).filter(Boolean).slice(0, n);
}
function boardRows(boards, key) {
  if (!boards) return [];
  if (Array.isArray(boards)) {
    const b = boards.find((x) => x.board === key || x.key === key || x.type === key || x.slug === key);
    return b ? firstArray(b, ["rows", "entries", "items", "ranks"]) : [];
  }
  return firstArray(boards[key], ["rows", "entries", "items", "ranks"]);
}

await buildSvsPages().catch((e) => log.push(`SvS 表示用ファイルの作成に失敗: ${e.message}`));
if (globalThis.__rotation) await writeJSON("rotation.json", globalThis.__rotation);
if (globalThis.__lang) {
  await writeJSON("lang.json", globalThis.__lang);
  const withBanner = Object.values(globalThis.__lang.states).filter((x) => x.banner).length;
  log.push(`旗(banner_url)が入っている王国: ${withBanner}件`);
}
meta.updated_at = now;
meta.watch_states = config.watch_states || [];
meta.watch_alliances = config.watch_alliances || [];
meta.hero_states = (await fs.readdir(path.join(DATA, "heroes")).catch(() => [])).filter((f) => f.endsWith(".json")).map((f) => Number(f.replace(".json", ""))).sort();
meta.api_calls = calls;
meta.log = log;
await writeJSON("meta.json", meta);
console.log(log.join("\n"));
console.log(`API呼び出し: ${calls}回`);
