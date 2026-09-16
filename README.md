# Discord Friend Manager

純前端的 Discord 好友整理工具，可部署至 GitHub Pages。介面可搜尋、排序、匯出、移除好友、重新送出好友邀請，並逐位補齊最後訊息時間。

> [!WARNING]
> Discord 明確表示使用一般使用者 token 自動化（self-bot）違反服務條款，可能造成帳號停權。此工具無法消除帳號風險，請自行評估後使用。

## 資料流與隱私

- Token 由使用者每次開啟頁面時輸入，只保存在該分頁的 JavaScript 記憶體。
- Token 不會寫入 IndexedDB、LocalStorage、Cookie、URL、Service Worker、操作紀錄或錯誤日誌。
- 好友快取、最後訊息掃描進度與操作紀錄只寫入目前瀏覽器的 IndexedDB。
- Discord 請求由瀏覽器直接送往 `https://discord.com/api/v10`，不經過自建伺服器。
- 網站沒有分析工具、錯誤追蹤、第三方 JavaScript、外部字型或自建 API。
- GitHub Pages 仍會收到提供靜態檔案所需的一般連線資料，例如 IP、User-Agent 與請求時間；不會收到 token 或 Discord 好友資料。
- Discord 與 Discord CDN 會收到執行 API 及載入頭像所必要的請求。

瀏覽器重新整理或關閉後會忘記 token，但 IndexedDB 快取仍會保留。按下「忘記 Token」可立即清除分頁記憶體中的 token；「清除快取」只清除好友快取，不會刪除操作紀錄。

## GitHub Pages

推送 `main` 後，[`.github/workflows/pages.yml`](.github/workflows/pages.yml) 會將 `static/` 直接部署至 GitHub Pages。Repository 的 **Settings > Pages > Source** 需設為 **GitHub Actions**。

部署網址預期為：

```text
https://apple050620312.github.io/DiscordFriendManager/
```

所有資源使用相對路徑，可在專案子路徑正常載入。

## 本機預覽

任何靜態檔案伺服器都可使用。例如：

```powershell
python -m http.server 8765 --directory static
```

開啟 `http://127.0.0.1:8765/`。直接以 `file://` 開啟可能因 ES modules 與瀏覽器安全限制而無法運作。

## 快取與限流

首次連線或按下「重新整理」時才會取得 relationships 與最近的 DM 頻道。已取得的資料會保存於 IndexedDB，重新開啟頁面不會自動重複請求 Discord。

「補齊時間」會逐位取得或建立 DM 頻道，從 `last_message_id` 在瀏覽器內計算最後訊息時間；不會讀取或傳送訊息，但部分舊 DM 可能重新出現在 Discord 私訊清單。每完成一位便保存一次進度，可中途暫停並在之後接續。

所有 Discord API 請求由同一佇列逐筆執行。遇到 429 時會讀取 `Retry-After`，bucket 用完時會讀取 `X-RateLimit-Reset-After`，等待後才繼續。

## 瀏覽器相容性

純 GitHub Pages 版本依賴 Discord 允許該 Pages origin 的 CORS 請求。Discord 已對一般瀏覽器回傳允許 origin 與 `Authorization` 的預檢 headers；Codex 內建瀏覽器則可能額外封鎖跨站授權請求，請改用一般 Chrome 或 Edge。若一般瀏覽器仍顯示網路錯誤，靜態網站不會改用會接觸 token 的代理伺服器。

## 移除與重新加好友

「移除好友」預設顯示確認視窗，按住 `Shift` 點擊可跳過確認。程式會先在 IndexedDB 建立 pending 操作紀錄，Discord 成功後才從本機好友清單移除；失敗則保存錯誤狀態。

已完成的移除紀錄可按「重新加好友」，確認後直接向 Discord 送出好友邀請並建立另一筆操作紀錄。
