// Whiteout Stats API からデータを取得して public/data/ に保存する
// GitHub Actions から毎日1回実行される想定。
// 必要な環境変数: WOS_API_KEY（GitHub の Secrets に保存）

import fs from "node:fs/promises";
import path from "node:path";

const API_BASE = process.env.WOS_API_BASE || "https://api.whiteoutstats.com/v1";
const API_KEY = process.env.WOS_API_KEY;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "public", "data");
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

// ---------- 本体 ----------
const now = new Date().toISOString();
const meta = await readJSON("meta.json", {});
const log = [];

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
    await writeJSON(`states/${kid}.json`, { updated_at: now, state: { ...state, boards: undefined }, boards });
    const jp = japaneseShare(boardRows(boards, "personal_power").map((r) => r.nick_name));
    if (jp) lang.states[kid] = { ...jp, at: now.slice(0, 10) };
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
      const members = firstArray(body.members ?? body.roster ?? body, ["members", "roster"]);
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

if (globalThis.__rotation) await writeJSON("rotation.json", globalThis.__rotation);
if (globalThis.__lang) await writeJSON("lang.json", globalThis.__lang);
meta.updated_at = now;
meta.api_calls = calls;
meta.log = log;
await writeJSON("meta.json", meta);
console.log(log.join("\n"));
console.log(`API呼び出し: ${calls}回`);
