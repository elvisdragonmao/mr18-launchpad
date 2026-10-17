#!/usr/bin/env bash
# Install Launchpad Mini MK3 -> MR18 as a boot-time Raspberry Pi service.
# Run as the normal Pi user, not with sudo: bash install_mr18_service.sh [MR18_IP]
set -euo pipefail

if [[ "$(id -u)" == "0" ]]; then
  echo '請用平常登入 Raspberry Pi 的使用者執行，不要 sudo bash。' >&2
  exit 1
fi

MR18_IP="${1:-10.3.255.251}"
if [[ ! "$MR18_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo '請提供 MR18 的 IPv4 位址，例如 10.3.255.251' >&2
  exit 1
fi
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SCRIPT_DIR}/mr18_launchpad.py"
APP_DIR="${HOME}/mr18-launchpad"
APP_FILE="${APP_DIR}/mr18_launchpad.py"
VENV_DIR="${HOME}/mr18-venv"
PYTHON="${VENV_DIR}/bin/python3"
SERVICE_NAME='mr18-launchpad.service'
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}"

if [[ ! -f "$SOURCE" ]]; then
  echo "同一個資料夾裡找不到 $SOURCE。請先放入 mr18_launchpad.py。" >&2
  exit 1
fi

mkdir -p "$APP_DIR"
cp "$SOURCE" "$APP_FILE"
if [[ ! -x "$PYTHON" ]]; then
  echo "尚未找到 $VENV_DIR，正在建立 Python venv..."
  if ! python3 -m venv "$VENV_DIR"; then
    echo 'venv 建立失敗，請先執行 sudo apt install python3-venv' >&2
    exit 1
  fi
fi
if ! "$PYTHON" -c 'import mido, rtmidi, pythonosc' >/dev/null 2>&1; then
  echo '安裝 Python MIDI/OSC 依賴套件...'
  "$PYTHON" -m pip install mido python-rtmidi python-osc
fi

# Use a system service (rather than user service) so login is not needed.
# The Python program reconnects itself if network/MR18/USB Launchpad is absent.
TMP_SERVICE="$(mktemp)"
trap 'rm -f "$TMP_SERVICE"' EXIT
cat > "$TMP_SERVICE" <<EOF
[Unit]
Description=Launchpad Mini MK3 controller for MIDAS MR18
After=network.target sound.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$(id -un)
SupplementaryGroups=audio
WorkingDirectory=${APP_DIR}
ExecStart=${PYTHON} -u ${APP_FILE} --arm --host ${MR18_IP}
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo install -m 0644 "$TMP_SERVICE" "$SERVICE_FILE"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
echo
printf '安裝完成！Service: %s / MR18: %s\n' "$SERVICE_NAME" "$MR18_IP"
echo '查看狀態：sudo systemctl status mr18-launchpad --no-pager'
echo '即時日誌：sudo journalctl -u mr18-launchpad -f'
echo '停止服務：sudo systemctl stop mr18-launchpad'
echo '取消開機啟動：sudo systemctl disable --now mr18-launchpad'
