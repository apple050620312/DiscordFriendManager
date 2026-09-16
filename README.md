# Discord Friend Analyze

在本機瀏覽、搜尋、排序、匯出及移除 Discord 好友。資料來自實際可取得的 relationships 欄位，包含關係類型、成為好友時間、自訂暱稱、備註、顯示名稱、帳號建立時間、公開旗標與 Guild Tag。

> [!WARNING]
> Discord 明確表示使用一般使用者 token 自動化（self-bot）違反服務條款，可能造成帳號停權。此工具只做唯讀請求並減少請求次數，但無法消除帳號風險。請自行評估後使用。

## 安裝與啟動

需要 Python 3.11 以上版本。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py
```

程式只監聽 `127.0.0.1:8765`，啟動後會開啟本機儀表板。`.env` 應為：

```dotenv
TOKEN=你的_user_token
```

`.env` 已由 Git 忽略。程式不會把 token 傳給瀏覽器、寫入快取或輸出到日誌。

## 快取與限流

首次啟動且沒有快取時才會登入並取得 relationships。之後每次啟動都直接讀取 `cache/relationships.json`，不會重複呼叫 Discord。`cache/` 也已由 Git 忽略。

`discord.py-self` 的 HTTP client 會讀取 Discord 的 rate-limit bucket、`X-RateLimit-*` 與 `Retry-After`，遇到 429 時動態等待；跨程序鎖則避免多個本機執行個體同時補快取。

若要取得全新資料，先明確清除快取：

```powershell
.\.venv\Scripts\python.exe app.py --clear-cache
.\.venv\Scripts\python.exe app.py
```

儀表板也提供「清除快取」。清除不會立刻觸發 API，停止並重新啟動後才會重新取得。

## 移除好友

好友列右側的「移除好友」預設會先顯示確認視窗。按住 `Shift` 再點擊可跳過確認。遠端刪除成功後，該筆資料才會從畫面與本機快取移除；失敗時不會改動快取。

刪除功能使用同一個延遲建立的 `discord.py-self` HTTP client 並逐筆執行，因此多次操作會共用 Discord 的動態 rate-limit 狀態，不會平行轟炸端點。

## 資料限制

relationships API 不提供最後互動時間、在線狀態或共同伺服器。本工具不會為了補這些欄位對每位好友額外發送請求。帳號建立時間由 Discord snowflake ID 在本機計算，不增加 API 用量。
