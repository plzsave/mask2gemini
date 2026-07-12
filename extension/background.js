// アイコンクリック → 表示中タブを撮影 → session storage に保存 → 確認画面を開く
chrome.action.onClicked.addListener(async (tab) => {
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
    // 撮影失敗・quota 超過時は capture を消し、確認画面側でエラー表示させる
    await chrome.storage.session.remove("capture");
    await chrome.storage.session.set({ captureError: String(e) });
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});
