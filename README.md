# 餐盤熱量計 PlateMeter

拍下飯前、飯後的餐盤照片，估算每樣食物吃了多少、實際攝取多少大卡。

## 功能
- 飯前／飯後拍照（可直接開相機或從相簿選），用 Claude 辨識食物、估算重量與熱量
- 每樣食物的飯前重量、剩下重量、每 100g 熱量都能手動修改；「吃光／¼／½／¾／沒動」快速設定
- 內建約 45 種台灣常見餐點，不拍照也能手動計算
- 「存入今天」累計每日攝取，可在「今日紀錄」查看與刪除

## 打包成 APK（GitHub Actions）
1. 在 GitHub 建一個新的 repository，把這個資料夾的全部內容推上去（含 `.github` 資料夾）。
2. 推到 `main` 分支後會自動開始打包；也可以在 **Actions → Build APK → Run workflow** 手動執行。
3. 跑完後點進那次執行，在 **Artifacts** 下載 `PlateMeter-debug-apk`，解壓縮後把 `app-debug.apk` 傳到手機安裝。

## 第一次使用
照片估算需要 Claude API 金鑰：
1. 到 https://console.anthropic.com 建立 API 金鑰（需要儲值少量額度）。
2. 打開 App →「設定」→ 貼上金鑰 → 儲存。

金鑰只存在手機上的 App 裡。沒有金鑰時，仍可用清單手動計算。

## 專案結構
- `app/src/main/assets/index.html`：整個畫面與計算邏輯（改介面、改食物清單都在這裡）
- `app/src/main/java/com/platemeter/app/MainActivity.kt`：WebView 外殼、相機／相簿選擇
- `.github/workflows/build.yml`：雲端打包流程
