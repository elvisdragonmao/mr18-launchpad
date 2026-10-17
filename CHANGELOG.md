# 版本紀錄

## v1.0.0 — 2026-10-17

第一個公開版本。

- 8×8 方格當成 8 條 8 段推桿，第 1 條為 Main LR 或 Aux Master。
- 右側按鈕切換 Main、Aux 1–6、Settings 頁。
- 上方 ◀ ▶ 切換 CH 1–7 / 8–14 / 15–16。
- Settings 頁切換 CH 1–16 Mute 與 USB / Line 來源。
- Main 頁依 MR18 的 Channel Link 設定同步 Stereo Pair 燈號。
- Launchpad USB 熱插拔自動重連。
- MR18 斷線時暫停寫入，恢復後重新讀取狀態，不寫回舊數值。
- `install_mr18_service.sh`：安裝成 systemd 服務，開機自動啟動、異常結束自動重啟。
