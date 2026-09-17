# 演講評論助手（PWA 版）

手機瀏覽器打開後可「加入主畫面」，像 App 一樣使用。錄音、轉錄、比對文獻庫、
產出報告全部在手機上完成。

## 部署方式（PWA 必須跑在 HTTPS 網址下，不能用 file:// 直接打開）

最簡單的方式：用 GitHub Pages 免費託管。

1. 在 GitHub 建一個新的 repository，把這個資料夾的檔案全部上傳
2. 到 repository 的 Settings → Pages，選擇要發布的分支（通常是 main），儲存
3. 幾分鐘後會拿到一個網址，例如 `https://your-username.github.io/lecture-feedback-pwa/`
4. 用手機瀏覽器打開這個網址

或者用 Netlify / Vercel 拖拉部署，也是幾分鐘內可以有網址，效果一樣。

## 設定步驟

### 1. Gemini API Key
- 到 Google AI Studio 申請一組 API Key
- 打開網頁後，直接貼在頁面最下方「Gemini API Key」欄位，會存在手機瀏覽器本機
  （不會上傳到任何伺服器）

### 2. Google Drive 授權（重要：需要先設定 OAuth）
- 到 Google Cloud Console 建立專案，啟用「Google Drive API」
- 建立 OAuth 用戶端 ID，類型選「網頁應用程式」
- 「已授權的 JavaScript 來源」填入您部署後的網址（例如
  `https://your-username.github.io`）
- 把取得的 Client ID 貼到 `app.js` 最上面 `CONFIG.GOOGLE_CLIENT_ID` 那一行
- 開啟網頁後按「連接 Google Drive」完成授權

### 3. 加到手機主畫面
- iPhone Safari：打開網址 → 分享按鈕 → 加入主畫面
- Android Chrome：打開網址 → 右上角選單 → 加到主畫面 / 安裝應用程式

## 目前架構與限制

- `index.html` / `style.css` / `app.js`：主要介面與邏輯
- `manifest.json`：PWA 設定（圖示需要您自己準備兩張 png 放進 `icons/` 資料夾，
  尺寸 192x192 與 512x512）
- `service-worker.js`：讓網頁殼層可以離線開啟（但錄音分析仍需要網路）

**安全性提醒**：Gemini API Key 是直接存在手機瀏覽器本機、由前端網頁直接呼叫
API，這對您個人使用沒有問題，但如果之後想分享給其他同事使用，建議改成後端
代理（by proxy server）呼叫 API，避免每個人都要自己填金鑰、也避免金鑰暴露
在前端程式碼中被看到。

**其餘限制**（與桌面版相同，供參考）：
- Google Drive 全文搜尋用關鍵字比對，中英文混雜查詢效果有限
- 逐字稿目前沒有讓您手動校正的介面，醫學術語可能需要事後自行修正
- 論點是逐一序列比對，論點數量多時處理時間會拉長
