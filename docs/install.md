# 安裝

## 需要的東西

- Raspberry Pi，跑 Raspberry Pi OS 或其他使用 systemd 的 Debian 系統
- Novation Launchpad Mini MK3，用 USB 接到 Raspberry Pi
- MIDAS MR18，和 Raspberry Pi 在同一個網路，且 Raspberry Pi 連得到 MR18 的 UDP 10024 埠
- Python 3 與 `python3-venv`

先確認 Raspberry Pi 連得到 MR18：

```sh
ping 10.3.255.251
```

## 1. 下載

從 GitHub Release 下載：

```sh
wget https://github.com/elvisdragonmao/mr18-launchpad/releases/latest/download/mr18-launchpad.zip
unzip mr18-launchpad.zip -d ~/mr18-launchpad-src
cd ~/mr18-launchpad-src
```

或直接 clone：

```sh
git clone https://github.com/elvisdragonmao/mr18-launchpad.git ~/mr18-launchpad-src
cd ~/mr18-launchpad-src
```

## 2. 停掉手動執行的舊版

如果之前有在終端機手動跑控制程式，先按 `Ctrl+C` 停掉。兩個程式同時開著會搶同一台 Launchpad。

## 3. 執行安裝腳本

```sh
bash install_mr18_service.sh 10.3.255.251
```

把 IP 換成你的 MR18。用平常登入的使用者執行，不要 `sudo bash`。

腳本會做這些事：

1. 把 `mr18_launchpad.py` 複製到 `~/mr18-launchpad/`。
2. 使用 `~/mr18-venv` 這個 Python 虛擬環境；不存在就建立，缺套件就用 pip 安裝 `mido`、`python-rtmidi`、`python-osc`。
3. 寫入 `/etc/systemd/system/mr18-launchpad.service`。
4. 啟用開機自動啟動，並立刻啟動服務。

這是 systemd 的 system service，以你的使用者身分、`audio` 群組執行，不需要登入桌面也會啟動。程式結束時 systemd 約 3 秒後重新啟動它。

服務以 `--arm` 模式執行，也就是按 Launchpad 會實際改變 MR18 的參數。

## 4. 安裝後驗證

先看服務狀態：

```sh
sudo systemctl status mr18-launchpad --no-pager
```

再開即時日誌，逐項實測：

```sh
sudo journalctl -u mr18-launchpad -f
```

- [ ] **拔插 Launchpad USB。** 拔掉後應該看到 `[Launchpad 斷線] MIDI Port 消失`，插回去約 2 秒內出現 `[Launchpad 已連接]`，燈號恢復。
- [ ] **中斷 MR18 網路。** 約 10 秒後出現 `[MR18 失聯]`，右上角燈變紅。恢復網路後出現 `[MR18 已連線 / 重新連線]`，燈號重新讀取。
- [ ] **重開 Raspberry Pi。** 不登入，直接按 Launchpad，應該可以操作。

## 更新

下載新版後在新資料夾裡再跑一次安裝腳本即可。腳本會覆蓋 `~/mr18-launchpad/` 的程式並重新啟動服務。

## 移除

```sh
sudo systemctl disable --now mr18-launchpad
sudo rm /etc/systemd/system/mr18-launchpad.service
sudo systemctl daemon-reload
rm -rf ~/mr18-launchpad
```

`~/mr18-venv` 若沒有其他程式在用，也可以刪掉。
