// 東京よさこいナビ - モーダル共通部品
// 背景クリック・Escキーで閉じる、role="dialog"、閉じたときに元のフォーカスへ戻す、までを一括で担う

import { el } from "../util.js";

const stack = []; // 開いているモーダル(後ろほど手前)。Escは一番手前だけを閉じる

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !stack.length) return;
  e.stopPropagation();
  stack[stack.length - 1]();
});

// モーダルを開き、中身を入れるsheetと閉じる関数を返す
export function openModal() {
  const root = document.getElementById("modal-root");
  const previouslyFocused = document.activeElement;
  const sheet = el("div", { class: "modal-sheet", role: "dialog", "aria-modal": "true", tabindex: "-1" });
  const backdrop = el("div", { class: "modal-backdrop", onclick: (e) => { if (e.target === backdrop) close(); } });
  backdrop.appendChild(sheet);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(close);
    if (i !== -1) stack.splice(i, 1);
    backdrop.remove();
    if (previouslyFocused && previouslyFocused.isConnected && typeof previouslyFocused.focus === "function") {
      previouslyFocused.focus({ preventScroll: true });
    }
  }

  stack.push(close);
  root.appendChild(backdrop);
  sheet.focus({ preventScroll: true });
  return { sheet, close };
}
