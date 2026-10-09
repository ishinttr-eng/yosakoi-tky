// モンキーテスト: ランダムなUI操作を連続で行い、操作のたびに「壊れてはいけない条件（不変条件）」を検査する。
// 手で順番に押す確認では通らない、状態依存の不具合（再描画・アニメーション・スクロール位置）を見つけるためのもの。
//
// 使い方（ブラウザのページ内で実行する。Orcaなら `orca eval --expression "$(cat tools/monkey_test.js)"`）:
//   1. 事前に localStorage へ確認用のお気に入り(tyk.favorites.v1)と時刻シミュレーション(tyk.settings.v1.simTime)を入れておく
//   2. このファイルを評価すると window.runMonkey が定義される
//   3. runMonkey({ seed: 1, ms: 60000 }) を呼ぶ（awaitしない）。進捗・結果は window.__monkey に入る
//   4. 終わったら確認用のお気に入り・シミュレーションを必ず消す
// 失敗したら同じseedで再現できる。失敗の記録には直近の操作列と直近の地図操作(Leaflet呼び出し)・現在のcenter/zoomを含める。
// 設定画面は閉じる以外触らない（文字サイズ・テーマ・シミュレーション等の永続設定を書き換えるため）。
(() => {
  const AREA_VENUES = { ikebukuro: [1, 2, 3, 4, 5, 6], "otsuka-sugamo": [7, 8] }; // エリア→ステージ番号

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  // 地図の視点移動を記録する（原因調査用: 「最後に呼ばれたのは何か」と「表示が何か」の矛盾から競合を特定する）
  const mapLog = [];
  function hookLeaflet() {
    if (!window.L || window.L.__monkeyHooked) return;
    window.L.__monkeyHooked = true;
    for (const fn of ["setView", "fitBounds", "flyTo", "panTo", "flyToBounds", "panBy", "setZoom"]) {
      const orig = window.L.Map.prototype[fn];
      if (!orig) continue;
      window.L.Map.prototype[fn] = function (...args) {
        const opt = args.find((a) => a && typeof a === "object" && "animate" in a);
        const summ = (a) => (a && a.lat !== undefined ? `${a.lat.toFixed(4)},${a.lng.toFixed(4)}` : a && a.getSouthWest ? `bounds(${a.getCenter().lat.toFixed(4)},${a.getCenter().lng.toFixed(4)})` : Array.isArray(a) ? a.slice(0, 2).map((x) => (+x).toFixed?.(4) ?? x).join(",") : typeof a === "object" ? "" : a);
        const entry = { t: Math.round(performance.now()), fn, args: args.slice(0, 2).map(summ).join(" | "), animate: opt ? opt.animate : "default", stack: (new Error().stack || "").split("\n")[2]?.trim().slice(0, 90) };
        mapLog.push(entry);
        if (mapLog.length > 30) mapLog.shift();
        const ret = orig.apply(this, args);
        try { const c = this.getCenter(); entry.after = `${c.lat.toFixed(4)},${c.lng.toFixed(4)} z${this.getZoom()}`; } catch {}
        return ret;
      };
    }
  }

  function visibleStageNos() {
    const lc = $(".leaflet-container");
    if (!lc) return null;
    const m = lc.getBoundingClientRect();
    const out = [];
    $$(".leaflet-marker-icon").forEach((e) => {
      const t = (e.textContent || "").trim();
      if (!/^\d+$/.test(t)) return;
      const r = e.getBoundingClientRect();
      if (r.left >= m.left && r.right <= m.right && r.top >= m.top && r.bottom <= m.bottom) out.push(+t);
    });
    return out.sort((a, b) => a - b);
  }

  // 不変条件。違反の説明文の配列を返す（空なら健全）
  function checkInvariants(ctx) {
    const v = [];
    const de = document.documentElement;
    if (de.scrollWidth > innerWidth + 1) v.push(`横スクロール: scrollWidth=${de.scrollWidth} > innerWidth=${innerWidth}`);
    const onMap = $("#app")?.classList.contains("screen-map");
    if (onMap) {
      if (de.scrollHeight > innerHeight + 1) v.push(`地図タブでページが縦に伸びている: scrollHeight=${de.scrollHeight} > innerHeight=${innerHeight}`);
      const mv = $("#map-view");
      const tb = $("#tabbar");
      if (mv && tb) {
        const m = mv.getBoundingClientRect();
        if (m.height < 199) v.push(`地図が最低高さを割っている: ${Math.round(m.height)}px`);
        if (m.bottom > tb.getBoundingClientRect().top + 1) v.push(`地図がタブバーに被っている: bottom=${Math.round(m.bottom)} tabTop=${Math.round(tb.getBoundingClientRect().top)}`);
        const lc = $("#map-view .leaflet-container, #map-view.leaflet-container");
        if (lc) {
          const lh = lc.getBoundingClientRect().height;
          if (Math.abs(lh - m.height) > 3) v.push(`Leafletコンテナの高さが枠と不一致: leaflet=${Math.round(lh)} map-view=${Math.round(m.height)}`);
        }
      }
      if (window.scrollY > 1) v.push(`地図タブでwindowがスクロールしている: scrollY=${scrollY}`);
    }
    // エリアタブ押下の直後（落ち着いた後）は、そのエリアの会場が画面に入り、タブのactiveと一致する
    if (ctx && ctx.expectArea && onMap && !$("#modal-root .modal-close")) {
      const active = $(".map-area-tab.active")?.dataset.area;
      if (active !== ctx.expectArea) v.push(`エリアタブのactiveが不一致: active=${active} expect=${ctx.expectArea}`);
      const vis = visibleStageNos() || [];
      const missing = AREA_VENUES[ctx.expectArea].filter((n) => !vis.includes(n));
      if (missing.length) v.push(`エリア${ctx.expectArea}の会場が画面外: 見えている=[${vis}] 欠け=[${missing}]`);
    }
    return v;
  }

  window.runMonkey = async function runMonkey({ seed = 1, ms = 60000 } = {}) {
    hookLeaflet();
    const rnd = mulberry32(seed);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const errors = [];
    const onErr = (e) => errors.push(`JS例外: ${(e.error && e.error.stack) || e.message}`);
    const onRej = (e) => errors.push(`未処理Promise拒否: ${(e.reason && e.reason.stack) || e.reason}`);
    addEventListener("error", onErr);
    addEventListener("unhandledrejection", onRej);

    // #mainの作り直し(=render)の時刻を記録する。「何が再描画を呼んだか」を後から追えるようにする
    const renderLog = [];
    const mo = new MutationObserver(() => { renderLog.push(Math.round(performance.now())); if (renderLog.length > 30) renderLog.shift(); });
    mo.observe($("#main"), { childList: true });
    const st = (window.__monkey = { seed, ms, ops: 0, done: false, failures: [], counts: {}, recent: [] });
    const t0 = performance.now();
    const opTimes = [];

    const closeModal = () => {
      const btn = $("#modal-root .modal-close");
      if (btn) btn.click();
      else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    };
    const modalOpen = () => !!$("#modal-root .modal-close");

    const actions = {
      tab: () => { const b = pick($$(".tab-btn:not([hidden])")); b.click(); return `tab:${b.dataset.tab}`; },
      areaTab: () => { const b = pick($$(".map-area-tab")); if (!b) return null; b.click(); return { desc: `area:${b.dataset.area}`, expectArea: b.dataset.area }; },
      myroute: () => { const b = $(".map-toolbar .toggle-btn"); if (!b) return null; b.click(); return "myroute-toggle"; },
      cardNav: () => { const n = $$(".myroute-nav"); if (!n.length) return null; const b = pick(n); b.click(); return `card-nav:${b === n[0] ? "prev" : "next"}`; },
      markerTap: () => { const m = $$(".leaflet-marker-icon").filter((e) => /^\d+$/.test((e.textContent || "").trim())); if (!m.length) return null; const e = pick(m); e.dispatchEvent(new MouseEvent("click", { bubbles: true })); return `marker:${e.textContent.trim()}`; },
      closeModal: () => { if (!modalOpen()) return null; closeModal(); return "modal-close"; },
      search: () => { const i = $(".map-toolbar .search-input"); if (!i) return null; i.value = pick(["", "1", "池袋", "大塚", "西口", "zzz"]); i.dispatchEvent(new Event("input", { bubbles: true })); return `search:${i.value}`; },
      scroll: () => { const main = $("#main"); const y = Math.floor(rnd() * 600); main.scrollTop = y; scrollTo(0, y); return `scroll:${y}`; },
      visibility: () => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); return "focus-event"; },
      resize: () => { window.dispatchEvent(new Event("resize")); return "resize-event"; },
    };
    // 状態依存の不具合が出やすい操作（エリア切替・マイルート・カード送り・モーダルを閉じる）を多めに引く
    const weights = [["areaTab", 6], ["myroute", 4], ["cardNav", 5], ["markerTap", 3], ["closeModal", 3], ["tab", 3], ["scroll", 2], ["search", 1], ["visibility", 1], ["resize", 1]];
    const bag = weights.flatMap(([k, w]) => Array(w).fill(k));

    while (performance.now() - t0 < ms && st.failures.length < 5) {
      const name = pick(bag);
      let res;
      try { res = actions[name](); } catch (e) { errors.push(`操作中の例外(${name}): ${e.stack || e.message}`); }
      if (!res) continue;
      const desc = typeof res === "string" ? res : res.desc;
      const expectArea = typeof res === "object" ? res.expectArea : null;
      st.ops++;
      opTimes.push(`${desc}@${Math.round(performance.now())}`); if (opTimes.length > 20) opTimes.shift();
      st.counts[name] = (st.counts[name] || 0) + 1;
      st.recent.push(desc);
      if (st.recent.length > 15) st.recent.shift();

      // エリアタブは、押した後に他の操作を挟まず落ち着くまで待ってから検査する（途中の不整合は検査しない）
      await sleep(expectArea ? 1100 : 120 + Math.floor(rnd() * 380));
      let violations = checkInvariants({ expectArea });
      if (errors.length) { violations = violations.concat(errors.splice(0)); }
      if (violations.length) {
        const lc = $(".leaflet-container");
        st.failures.push({
          op: st.ops, after: desc, violations,
          recentOps: [...st.recent],
          lastMapCalls: mapLog.slice(-8),
          renders: renderLog.slice(-8),
          opTimes: opTimes.slice(-8),
          nowT: Math.round(performance.now()),
          visible: visibleStageNos(),
          tab: $(".tab-btn.active")?.dataset.tab, area: $(".map-area-tab.active")?.dataset.area,
          mapDivH: Math.round($("#map-view")?.getBoundingClientRect().height || 0),
          leafletPresent: !!lc,
        });
        // 同じ状態から連鎖して同じ違反を積まないよう、一度タブを切り替えて立て直す
        $(".tab-btn[data-tab=now]")?.click();
        await sleep(300);
      }
      if (modalOpen() && rnd() < 0.5) { closeModal(); await sleep(100); }
    }
    mo.disconnect();
    removeEventListener("error", onErr);
    removeEventListener("unhandledrejection", onRej);
    st.elapsedMs = Math.round(performance.now() - t0);
    st.done = true;
    return st;
  };
  return "monkey ready";
})();
