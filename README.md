# 餐盤熱量計 PlateMeter

拍下飯前、飯後的餐盤照片，估算每樣食物吃了多少、實際攝取多少大卡。

## 功能
- **手機離線辨識（預設，免費）**：手機上的小模型（MobileCLIP2-S0，約 45MB）辨識照片中的菜，比對飯前飯後算出剩下的比例。不用網路，4GB 記憶體的手機也能跑。
- **Claude API（選用）**：在「設定」切換，照片交給 Claude 辨識，比較準但需要 API 金鑰。
- 每道菜會列出「也可能是」的其他選項，點一下就能換；公克數、熱量都能手動改。
- **會越用越準**：按「存入今天」時，App 會記住這餐每道菜的樣子。下次拍到類似的菜，會優先認成你確認過的名字。清單裡沒有的菜，只要改名存一次，之後也認得。
- 「今日紀錄」累計每天的攝取量。

## 打包成 APK（GitHub Actions）
1. 把這個資料夾的全部內容推到 GitHub repository 的 `main` 分支（含 `.github` 資料夾）。
2. Actions 會自動執行：
   - 第一次會先下載模型、轉成手機用的格式（多 5–10 分鐘）。之後只要 `tools/` 沒改，就直接用快取。
   - 接著打包 APK。
3. 跑完後在 **Artifacts** 下載 `PlateMeter-debug-apk`，解壓縮後安裝 `app-debug.apk`。

## 調整菜單
編輯 `tools/foods.json` 就能新增或修改菜：
- `zh`：App 顯示的名稱
- `en`：給模型比對用的英文描述，越具體越好（例如加上食材、顏色、盛裝方式）
- `kcal`：每 100 公克熱量
- `g`：常見一份的公克數

推上 GitHub 後，Actions 會自動重新產生模型資料。

## 專案結構
- `tools/foods.json`、`tools/build_model.py`：菜單與模型轉換（在 GitHub Actions 執行）
- `app/src/main/assets/index.html`：畫面與流程
- `app/src/main/assets/engine.js`：離線辨識的比對、剩餘比例計算與學習邏輯
- `app/src/main/java/.../FoodEmbedder.kt`：在手機上執行模型（ONNX Runtime）
- `app/src/main/java/.../MainActivity.kt`：App 外殼、相機／相簿
