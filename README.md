# MR18 Launchpad

把 Novation Launchpad Mini MK3 當成 MIDAS MR18 的實體控制器。程式跑在 Raspberry Pi 上，透過 USB 讀 Launchpad、透過網路用 OSC 控制 MR18，開機後自動啟動，不需要接螢幕或 SSH 登入。

說明網站：<https://g.elvismao.com/mr18-launchpad/>，上面有可以直接按的 Launchpad 模擬器，以及一步步帶你操作的練習。

## 功能

- 8×8 方格當成 8 條 8 段推桿：第 1 條是 Main LR 或目前選擇的 Aux，其餘 7 條是輸入聲道。
- 右側按鈕切換頁面：Main、Aux 1–6、Settings。
- 上方 ◀ ▶ 切換聲道 Bank：CH 1–7、8–14、15–16。
- Settings 頁：CH 1–16 的 Mute，以及每個聲道的 USB / Line 來源切換。
- Main 頁依 MR18 的 Channel Link 設定，讓 Stereo Pair 兩個聲道的燈號同步。
- Launchpad USB 拔插、MR18 斷網、Raspberry Pi 重開機，都會自動恢復。
- 重新連上 MR18 時會先讀取混音器目前的數值，不會把斷線前的舊數值寫回去。

完整的按鍵對照見 [docs/controls.md](docs/controls.md)。

## 快速安裝

在 Raspberry Pi 上：

```sh
wget https://github.com/elvisdragonmao/mr18-launchpad/releases/latest/download/mr18-launchpad.zip
unzip mr18-launchpad.zip -d ~/mr18-launchpad-src
cd ~/mr18-launchpad-src
bash install_mr18_service.sh 10.3.255.251
```

最後一個參數換成你的 MR18 IP。用一般使用者執行，不要加 `sudo`；腳本會在需要時自己呼叫 `sudo`。

詳細步驟與需求見 [docs/install.md](docs/install.md)。

## 文件

| 文件 | 內容 |
| --- | --- |
| [docs/install.md](docs/install.md) | 需求、安裝、安裝後驗證 |
| [docs/controls.md](docs/controls.md) | 按鍵與燈號對照 |
| [docs/operations.md](docs/operations.md) | 服務管理、日誌、手動測試、斷線行為、疑難排解 |
| [CHANGELOG.md](CHANGELOG.md) | 版本紀錄 |

## 檔案

| 檔案 | 說明 |
| --- | --- |
| `mr18_launchpad.py` | 控制程式 |
| `install_mr18_service.sh` | 部署程式並建立 systemd 服務 |
| `requirements.txt` | Python 依賴套件 |
| `site/` | GitHub Pages 說明網站 |
