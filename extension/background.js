// アイコンクリック → 表示中タブを撮影＋DOM 抽出 → session storage に保存 → 確認画面を開く。
// 撮影と DOM 走査は同一クリックハンドラ内で連続実行し、スクロール等による座標ズレを防ぐ
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.storage.session.remove(["capture", "captureError", "domExtract", "domExtractError"]);
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await chrome.storage.session.set({
      capture: {
        dataUrl,
        title: tab.title ?? "",
        capturedAt: Date.now(),
      },
    });
  } catch (e) {
    // 撮影失敗・quota 超過時は確認画面側でエラー表示させる
    await chrome.storage.session.set({ captureError: String(e) });
  }
  // DOM 抽出（Issue #13・確定事項9）。activeTab の一時ホスト権限で注入する。
  // 注入不可（chrome://・PDF ビューア等）なら domExtractError を残し、
  // review.js が OCR 経路に自動フォールバックする
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["dom-extractor.js"],
    });
    if (injection?.result) {
      await chrome.storage.session.set({ domExtract: injection.result });
    } else {
      await chrome.storage.session.set({ domExtractError: "抽出結果が空" });
    }
  } catch (e) {
    await chrome.storage.session.set({ domExtractError: String(e) });
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});
