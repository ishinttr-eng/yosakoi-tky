// 東京よさこいナビ - 状態管理・データ読み込み

import { toMin, perfKey, normalize, estimateWalkMin, applyEvent, DAYS, EVENT } from "./util.js";

const LS = {
  favorites: "tyk.favorites.v1",
  settings: "tyk.settings.v1",
  seenChanges: "tyk.seenChanges.v1",
  helpSeen: "tyk.helpSeen.v1",
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore quota errors */
  }
}

export const state = {
  venues: [],
  venueMap: new Map(), // 会場ID → 会場
  performances: [],
  perfByKey: new Map(), // perfKey → 演目（お気に入りの解決用）
  walktimes: null,
  routes: null,
  tieup: { stages: [] },
  checked: null,
  changes: null,
  appChangelog: null,
  performancesUpdatedAt: null,
  favorites: new Set(loadJSON(LS.favorites, [])),
  settings: Object.assign(
    {
      fontSize: "normal", // normal | large
      simTime: null, // "2026-10-10T13:00" 等
      simGeo: null, // {lat,lng}
      autoLocate: false,
      theme: "system",
    },
    loadJSON(LS.settings, {})
  ),
  seenChangeAt: loadJSON(LS.seenChanges, null),
  currentGeo: null,
};

// 旧形式のお気に入りキー(p-0001__2026-10-10__10:30)を安定ID(p-xxxxxxxx)へ変換する。
// 変換表(legacy_ids.json)に無い旧形式キーは対応する演目が特定できないため null を返す
const LEGACY_KEY_RE = /^(p-\d{4})__/;
let legacyIdMap = {};
export function migrateFavoriteKey(key) {
  if (typeof key !== "string") return null;
  const m = LEGACY_KEY_RE.exec(key);
  if (!m) return key;
  return legacyIdMap[m[1]] || null;
}
function migrateFavorites() {
  // 変換表を取得できなかった時に旧キーを消してしまわないよう、表が空なら何もしない（次回起動で再試行）
  if (!Object.keys(legacyIdMap).length) return;
  const before = [...state.favorites];
  const after = new Set(before.map(migrateFavoriteKey).filter(Boolean));
  if (after.size === before.length && before.every((k) => after.has(k))) return;
  state.favorites = after;
  persistFavorites();
}

export function persistFavorites() {
  saveJSON(LS.favorites, [...state.favorites]);
}
export function persistSettings() {
  saveJSON(LS.settings, state.settings);
}
// 使い方ページの初回表示済みフラグを保存する。保存できない環境（プライベートモード等）では
// 毎回の起動で使い方ページへ飛ばしてしまうため、書き込めたことを読み戻して確認し、結果を返す
export function markHelpSeen() {
  saveJSON(LS.helpSeen, true);
  return loadJSON(LS.helpSeen, false) === true;
}
export function isHelpSeen() {
  return loadJSON(LS.helpSeen, false) === true;
}
export function persistSeenChanges() {
  saveJSON(LS.seenChanges, state.seenChangeAt);
}

export function toggleFavorite(p) {
  const key = perfKey(p);
  if (state.favorites.has(key)) state.favorites.delete(key);
  else state.favorites.add(key);
  persistFavorites();
}
export function isFavorite(p) {
  return state.favorites.has(perfKey(p));
}
// 同じチーム(公式ページ、無ければ名前)として扱うキー
export function teamKey(p) {
  return p.officialUrl || p.name;
}
// この枠と時間が重なる別のお気に入り枠（無ければnull）。同じ日で、枠の時間帯が少しでも重なれば重複とみなす
export function conflictingFavorite(p) {
  if (!state.favorites.size || isFavorite(p)) return null;
  return (
    state.performances.find(
      (x) => x.date === p.date && x.startMin < p.endMin && p.startMin < x.endMin && state.favorites.has(perfKey(x))
    ) || null
  );
}
// この枠自体は未登録だが、同じチームの別の枠がお気に入りに入っているか
export function hasOtherSlotFavorite(p) {
  if (!state.favorites.size || isFavorite(p)) return false;
  const k = teamKey(p);
  return state.performances.some((x) => teamKey(x) === k && state.favorites.has(perfKey(x)));
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`fetch failed: ${path}`);
  return res.json();
}

export async function loadAll() {
  const [venues, performances, event] = await Promise.all([
    fetchJSON("data/venues.json"),
    fetchJSON("data/performances.json"),
    fetchJSON("data/event.json"),
  ]);
  applyEvent(event);
  state.venues = venues.venues;
  state.venueMap = new Map(state.venues.map((v) => [v.id, v]));
  state.performances = performances.performances.map((p) => ({
    ...p,
    startMin: toMin(p.start),
    endMin: toMin(p.end),
    // 検索用の正規化済みテキスト（キー入力のたびに全演目を正規化し直さないよう、読み込み時に1回だけ作る）
    searchText: [p.name, p.kana, p.awardEntry].map(normalize).join("\n"),
  }));
  state.perfByKey = new Map(state.performances.map((p) => [perfKey(p), p]));
  state.performancesUpdatedAt = performances.updatedAt || null;

  const optional = async (path, fallback) => {
    try {
      return await fetchJSON(path);
    } catch {
      return fallback;
    }
  };
  const [walktimes, routes, tieup, checked, changes, appChangelog, legacyIds] = await Promise.all([
    optional("data/walktimes.json", null),
    optional("data/routes.json", { routes: {} }),
    optional("data/tieup.json", { stages: [] }),
    optional("data/checked.json", null),
    optional("data/changes.json", { history: [] }),
    optional("data/app_changelog.json", { entries: [] }),
    optional("data/legacy_ids.json", { map: {} }),
  ]);
  state.walktimes = walktimes;
  state.routes = routes;
  state.tieup = tieup;
  state.checked = checked;
  state.changes = changes;
  state.appChangelog = appChangelog;
  legacyIdMap = legacyIds.map || {};
  migrateFavorites();
}

export function venueById(id) {
  return state.venueMap.get(id);
}

let walkIndexCache = null;
function walkIndex() {
  if (walkIndexCache?.src !== state.walktimes) {
    const { ids, minutes } = state.walktimes;
    walkIndexCache = { src: state.walktimes, index: new Map(ids.map((id, i) => [id, i])), minutes };
  }
  return walkIndexCache;
}

export function walkMinutes(idA, idB) {
  if (!state.walktimes || idA === idB) return 0;
  const { index, minutes } = walkIndex();
  const i = index.get(idA);
  const j = index.get(idB);
  if (i === undefined || j === undefined) return null;
  return minutes[i][j];
}

// 会場同士の徒歩分数。実測(walktimes)が無いペアは直線距離からの概算で補う
export function walkMinutesBetween(a, b) {
  return walkMinutes(a.id, b.id) ?? estimateWalkMin(a.lat, a.lng, b.lat, b.lng);
}

export function routeBetween(idA, idB) {
  if (!state.routes) return null;
  const key = [idA, idB].sort().join("|");
  return state.routes.routes[key] || null;
}

export async function fetchWeather() {
  try {
    const { lat, lng } = EVENT.weather;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,precipitation_probability,weathercode&timezone=Asia%2FTokyo&start_date=${DAYS[0]}&end_date=${DAYS[DAYS.length - 1]}`;
    const res = await fetch(url);
    if (!res.ok) {
      // Open-Meteoの無料予報は開催日の16日前を切るまで該当日のデータが
      // 存在せずHTTP 400になる（"start_date out of allowed range"等）。
      // バッジには表示せず(呼び出し側で「-」にフォールバック)、開発時に
      // 「壊れている」のか「まだ予報が無いだけ」なのか判別できるよう理由だけ出す。
      let reason = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.reason) reason = body.reason;
      } catch {
        /* エラーレスポンスがJSONでない場合はHTTPステータスのみ出す */
      }
      console.warn(`[weather] 天気予報を取得できませんでした: ${reason}`);
      return null;
    }
    const data = await res.json();
    const map = {};
    data.hourly.time.forEach((t, i) => {
      map[t] = {
        temp: data.hourly.temperature_2m[i],
        pop: data.hourly.precipitation_probability[i],
        code: data.hourly.weathercode[i],
      };
    });
    return map;
  } catch (e) {
    console.warn("[weather] 天気予報の取得に失敗しました:", e);
    return null;
  }
}

export function weatherIcon(code) {
  if (code == null) return "";
  if (code === 0) return "☀️";
  if ([1, 2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45, 48].includes(code)) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "❄️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "☁️";
}
