# 操作與維護

## 管理服務

```sh
# 查看狀態
sudo systemctl status mr18-launchpad --no-pager

# 即時日誌
sudo journalctl -u mr18-launchpad -f

# 重啟
sudo systemctl restart mr18-launchpad

# 暫時停止
sudo systemctl stop mr18-launchpad

# 再次啟動
sudo systemctl start mr18-launchpad

# 取消開機自動執行並停止
sudo systemctl disable --now mr18-launchpad
```

`systemctl status` 顯示 active 只代表程式在跑，不代表 MR18 在線。要看日誌裡的 `[MR18 已連線]` 或 `[MR18 失聯]`。

## 斷線與恢復

| 情況 | 程式的處理 |
| --- | --- |
| Launchpad USB 被拔掉 | 偵測到 MIDI Port 消失，程式繼續執行 |
| Launchpad 重新插入 | 每 2 秒掃描一次，找到後重新開啟 MIDI Port、切回 Programmer Mode、重畫燈號 |
| MR18 網路中斷 | 每 3 秒送一次 `/xinfo`，超過 10 秒沒回應就判定失聯並暫停寫入 |
| MR18 網路恢復 | 收到 `/xinfo` 回覆後清掉舊數值，重新查詢音量、Mute、來源 |
| Raspberry Pi 重開機 | systemd 開機自動啟動，Launchpad 或 MR18 還沒準備好也沒關係 |
| 程式意外結束 | systemd 約 3 秒後重新啟動 |

Linux 的 ALSA MIDI Port 編號在拔插後可能改變，程式每次重連都會重新用名稱比對 Launchpad，所以不受影響。

恢復連線時程式只會讀取 MR18 的數值，不會把斷線前記住的推桿值寫回去。

拔插 Launchpad 時日誌會出現：

```
[Launchpad 斷線] MIDI Port 消失；插回 USB 後會自動重連
[等待 Launchpad] 尚未找到 Mini MK3，插入 USB 後會自動連接。
[Launchpad 已連接] Input=...; Output=...
```

## 手動測試

先停掉服務，避免兩個程式同時控制：

```sh
sudo systemctl stop mr18-launchpad
source ~/mr18-venv/bin/activate
cd ~/mr18-launchpad
```

不加 `--arm` 是預覽模式，按 Launchpad 只會印出要送的 OSC，不會改動 MR18：

```sh
python3 mr18_launchpad.py --host 10.3.255.251
```

確認沒問題再加 `--arm` 實際操作：

```sh
python3 mr18_launchpad.py --host 10.3.255.251 --arm
```

`--arm` 會直接改變音量和輸入來源，請在沒有重要音源的情況下測試。測完按 `Ctrl+C`，再把服務開回來：

```sh
sudo systemctl start mr18-launchpad
```

### 命令列參數

| 參數 | 預設值 | 說明 |
| --- | --- | --- |
| `--host` | `10.3.255.251` | MR18 的 IP |
| `--port` | `10024` | MR18 的 OSC UDP 埠 |
| `--arm` | 關閉 | 允許實際改變 MR18 參數 |
| `--list-ports` | — | 列出 MIDI Port 後結束 |
| `--input` | 自動偵測 | 指定 MIDI 輸入 Port 名稱 |
| `--output` | 自動偵測 | 指定 MIDI 輸出 Port 名稱 |

不建議指定 `--input` / `--output`：Port 名稱裡含有 ALSA client ID，拔插後可能改變，指定了反而會連不回去。

## 疑難排解

**日誌一直是 `[等待 Launchpad]`**

列出 MIDI Port，確認 Raspberry Pi 有看到 Launchpad：

```sh
~/mr18-venv/bin/python3 ~/mr18-launchpad/mr18_launchpad.py --list-ports
```

清單裡應該要有名稱含 `Launchpad` 或 `LPMini` 的項目。沒有的話換一條 USB 線或換一個 USB 孔。

**狀態燈一直是紅的**

Raspberry Pi 收不到 MR18 的回覆。確認：

- `ping <MR18 IP>` 通不通。
- 安裝時給的 IP 對不對。IP 寫在 `/etc/systemd/system/mr18-launchpad.service` 的 `ExecStart` 那一行；要改就用新 IP 重跑安裝腳本。
- 中間的網路設備沒有擋 UDP 10024。

**pip 安裝 `python-rtmidi` 失敗**

沒有可用的預編譯套件時 pip 會從原始碼編譯，需要 ALSA 開發檔：

```sh
sudo apt install build-essential python3-dev libasound2-dev
```

裝完再跑一次安裝腳本。

**M-AIR Edit 可以同時使用嗎？**

可以。兩邊的改動會互相反映。
