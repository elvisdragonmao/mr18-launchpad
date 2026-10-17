#!/usr/bin/env python3
"""Launchpad Mini MK3 -> MIDAS MR18 OSC control surface with hot-plug recovery.

Physical mapping (Launchpad Programmer Mode):
- 8x8 grid: 8 vertical 8-step faders. Column 1 is the master (Main LR or selected Bus).
- Top LEFT/RIGHT arrows (CC 93/94): bank CH 1-7 / 8-14 / 15-16.
- Right scene buttons (CC 89..19): Main, Aux 1..6, Settings.
- Settings grid: row 1/2 input mute CH1-8/CH9-16; row 3/4 USB input source CH1-8/CH9-16.

Read queries + /xremote subscriptions share one UDP socket so OSC replies come back here.
The mixer is never changed just by starting the app. Use --arm to enable writes.
Launchpad unplug/replug and mixer/network outages recover without restarting.
When the MR18 is offline, writes are disabled; reconnect refreshes state by OSC GET.

"""

import argparse
import bisect
import socket
import sys
import time

try:
    import mido
    from pythonosc.osc_message import OscMessage
    from pythonosc.osc_message_builder import OscMessageBuilder
except ImportError as exc:
    sys.exit(f"缺少 Python 套件: {exc}\n請先安裝 mido、python-rtmidi、python-osc。")

MIDI_SYSEX_HEADER = (0, 32, 41, 2, 13)
RIGHT_BUTTONS = [89, 79, 69, 59, 49, 39, 29, 19]  # top-to-bottom
# Bottom to top: -infinity (absolute minimum), -60, -45, -30, -20, -10,
# -5, 0 dB. 0 dB = 0.75 in X-Air OSC; values > 0.75 are positive gain.
# Exact values derive from the X-Air piecewise dB-to-normalized-fader taper.
FADER_STEPS = (0.0, 0.0625, 0.15625, 0.25, 0.375, 0.5, 0.625, 0.75)
FADER_MIDPOINTS = tuple((a + b) / 2 for a, b in zip(FADER_STEPS, FADER_STEPS[1:]))


def fader_bar_count(value):
    """Return 1..8 steps; 1 means bottom pad shows fader at absolute zero.

    Thresholds are halfway between steps rather than AT each nominal value:
    this tolerates mixer 1024-step rounding and stops off-by-one LEDs.
    A positive-but-tiny fader still shows at least two pads, to distinguish it
    from an actual 0.0/off setting.
    """
    value = max(0.0, min(1.0, float(value)))
    if value <= 1e-7:
        return 1
    return max(2, min(8, bisect.bisect_right(FADER_MIDPOINTS, value) + 1))


def channel_link_path(ch):
    """Return the stereo link flag path for channel 1..16."""
    odd = ch if ch % 2 else ch - 1
    return f"/config/chlink/{odd}-{odd+1}"
TOP_LEFT = 93
TOP_RIGHT = 94
COLORS = {
    "off": 0,
    "white": 3,
    "red": 5,
    "orange": 9,
    "yellow": 13,
    "green_dim": 17,
    "green": 21,
    "blue": 45,
    "purple": 49,
}


def pad_note(row, col):
    """8x8 grid: (top-left) 81 through (bottom-right) 18."""
    return 10 * (8 - row) + 1 + col


def osc_packet(path, value=None):
    builder = OscMessageBuilder(address=path)
    if value is not None:
        builder.add_arg(value)
    return builder.build().dgram


def find_launchpad_port(names, specified, direction):
    if specified:
        if specified not in names:
            raise RuntimeError(f"找不到 {direction} Port '{specified}'，可用: {names}")
        return specified
    candidates = [n for n in names if "launchpad" in n.lower() or "lpmini" in n.lower()]
    if not candidates:
        raise RuntimeError(f"找不到 Launchpad {direction} Port。可用的 Ports: {names}")
    # Prefer the regular 'MIDI' interface, rather than the DAW interface.
    non_daw = [n for n in candidates if "daw" not in n.lower()]
    if non_daw:
        candidates = non_daw
    if len(candidates) > 1:
        # On platforms reporting two unnamed numbered interfaces, the second
        # interface is the regular MIDI interface as per Novation's manual.
        candidates = candidates[-1:]
    return candidates[0]


class Controller:
    def __init__(self, args):
        self.args = args
        self.midi_in = None
        self.midi_out = None
        self.midi_in_name = None
        self.midi_out_name = None
        self.last_midi_scan = -10.0
        self.waiting_midi_logged = False
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("0.0.0.0", 0))
        self.sock.setblocking(False)
        self.target = (args.host, args.port)
        self.page = 0    # 0 Main, 1..6 Aux, 7 Settings
        self.bank = 0    # Each bank shows 7 input channels
        self.cache = {}  # Latest known OSC path => (value, received_at)
        self.led_cache = {}
        self.last_keepalive = 0.0
        self.last_probe = 0.0
        self.last_xinfo = 0.0
        self.last_query = 0.0
        self.last_draw = 0.0
        self.last_osc_error = -10.0
        self.info_ok = False
        self.connected_at = None
        self.draw_dirty = False
        self.pending_readback = {}  # path -> delayed SET verification time

    def close_midi(self, reason=None):
        """Forget disconnected ALSA endpoints; reacquire fresh port names later."""
        if reason and (self.midi_in is not None or self.midi_out is not None):
            print(f"[Launchpad 斷線] {reason}；插回 USB 後會自動重連", flush=True)
        for port in (self.midi_in, self.midi_out):
            if port is not None:
                try:
                    port.close()
                except Exception:
                    pass
        self.midi_in = self.midi_out = None
        self.midi_in_name = self.midi_out_name = None
        self.led_cache.clear()
        self.draw_dirty = True

    def ensure_midi(self, now):
        """Poll live MIDI port enumeration so USB hot-plug changes are detected.

        RtMidi port names contain changing ALSA IDs, so we resolve names on every
        new connection instead of remembering the name from the previous boot.
        """
        if now - self.last_midi_scan < 2.0:
            return
        self.last_midi_scan = now
        try:
            inputs = mido.get_input_names()
            outputs = mido.get_output_names()
        except Exception as exc:
            self.close_midi(f"掃描 MIDI 裝置失敗：{exc}")
            return
        if self.midi_in is not None:
            if self.midi_in_name not in inputs or self.midi_out_name not in outputs:
                self.close_midi("MIDI Port 消失")
            else:
                return  # Current USB connection is still enumerated.
        try:
            input_name = find_launchpad_port(inputs, self.args.input, "input")
            output_name = find_launchpad_port(outputs, self.args.output, "output")
        except RuntimeError:
            if not self.waiting_midi_logged:
                print("[等待 Launchpad] 尚未找到 Mini MK3，插入 USB 後會自動連接。", flush=True)
                self.waiting_midi_logged = True
            return
        midi_in = midi_out = None
        try:
            midi_in = mido.open_input(input_name)
            midi_out = mido.open_output(output_name)
            self.midi_in, self.midi_out = midi_in, midi_out
            self.midi_in_name, self.midi_out_name = input_name, output_name
            self.send_sysex(14, 1)  # Re-enter Programmer Mode after replug.
            self.waiting_midi_logged = False
            print(f"[Launchpad 已連接] Input={input_name}; Output={output_name}", flush=True)
            self.led_cache.clear()
            # On reconnection the old cache may be stale. Read all relevant
            # MR18 parameters before showing a full updated fader display.
            self.cache.clear()
            self.pending_readback.clear()
            if self.info_ok:
                self.refresh_queries()
            self.draw_dirty = True
        except Exception as exc:
            self.close_midi(f"開啟/初始化 Port 失敗：{exc}")
            if midi_in is not None and midi_in is not self.midi_in:
                try:
                    midi_in.close()
                except Exception:
                    pass
            if midi_out is not None and midi_out is not self.midi_out:
                try:
                    midi_out.close()
                except Exception:
                    pass

    def send_osc(self, address, value=None, *, writing=False):
        if writing and not self.args.arm:
            print(f"[預覽，未改變 MR18] {address} = {value}")
            return False
        if writing and not self.info_ok:
            print(f"[拒絕寫入：MR18 未連線] {address} = {value}")
            return False
        try:
            self.sock.sendto(osc_packet(address, value), self.target)
        except OSError as exc:
            now = time.monotonic()
            if now - self.last_osc_error >= 8:
                print(f"[OSC 傳送失敗] {exc}；網路恢復後會自動重試", flush=True)
                self.last_osc_error = now
            return False
        if writing:
            print(f"[送出 OSC] {address} = {value}")
        return True

    def send_sysex(self, command, value):
        self.midi_out.send(mido.Message(
            "sysex", data=MIDI_SYSEX_HEADER + (command, value)))

    def set_led(self, kind, number, color):
        key = (kind, number)
        if self.led_cache.get(key) == color:
            return
        self.led_cache[key] = color
        if kind == "note":
            self.midi_out.send(mido.Message("note_on", note=number,
                                            velocity=color, channel=0))
        else:
            self.midi_out.send(mido.Message("control_change", control=number,
                                            value=color, channel=0))

    def get(self, path):
        data = self.cache.get(path)
        return data[0] if data is not None else None

    def main_linked_partner(self, ch):
        """Other half if Main L/R channel faders are configured as a linked pair.

        MR18's channel link and 'Fader, Mute, Sends' link preference must BOTH
        be enabled; on an Aux page sends can behave differently, so we don't
        invent linked values there.
        """
        if self.page != 0 or ch < 1 or ch > 16:
            return None
        link_enabled = self.get(channel_link_path(ch))
        fader_link_enabled = self.get('/config/linkcfg/fdrmute')
        if link_enabled is None or fader_link_enabled is None:
            return None
        if int(link_enabled) != 1 or int(fader_link_enabled) != 1:
            return None
        return ch + 1 if ch % 2 else ch - 1

    def fader_display_value(self, col):
        """Show one identical bar height for a Main-page stereo-linked pair.

        Prefer the odd channel as the stable display reference, rather than
        whichever OSC GET reply happens to arrive last. This changes LEDs,
        never writes the other channel's fader into the MR18.
        """
        path = self.fader_path(col)
        if path is None:
            return None
        if col > 0 and self.page == 0:
            ch = self.bank * 7 + col
            if self.main_linked_partner(ch) is not None:
                odd_ch = ch if ch % 2 else ch - 1
                canonical = self.get(f'/ch/{odd_ch:02d}/mix/fader')
                if canonical is not None:
                    return canonical
        return self.get(path)

    def master_path(self):
        return "/lr/mix/fader" if self.page == 0 else f"/bus/{self.page}/mix/fader"

    def fader_path(self, col):
        if col == 0:
            return self.master_path()
        ch = self.bank * 7 + col
        if ch > 16:
            return None
        if self.page == 0:
            return f"/ch/{ch:02d}/mix/fader"
        return f"/ch/{ch:02d}/mix/{self.page:02d}/level"

    def refresh_queries(self):
        if self.page < 7:
            paths = [self.fader_path(i) for i in range(8)]
        else:
            paths = ([f"/ch/{ch:02d}/mix/on" for ch in range(1, 17)] +
                     [f"/ch/{ch:02d}/preamp/rtnsw" for ch in range(1, 17)])
        # Refresh both members of linked pairs, including the one outside the
        # visible bank. GETs never change mixer state.
        if self.page == 0:
            for path in tuple(paths):
                if path and path.startswith('/ch/') and path.endswith('/mix/fader'):
                    ch = int(path.split('/')[2])
                    partner = ch + 1 if ch % 2 else ch - 1
                    paths.append(f'/ch/{partner:02d}/mix/fader')
        paths.extend(f'/config/chlink/{odd}-{odd+1}' for odd in range(1,17,2))
        paths.append('/config/linkcfg/fdrmute')
        for path in dict.fromkeys(p for p in paths if p):
            self.send_osc(path)  # No OSC value = request current state.
        self.last_query = time.monotonic()

    def draw(self, force=False):
        if self.midi_out is None:
            return
        if force:
            self.led_cache.clear()
        for row in range(8):
            for col in range(8):
                color = COLORS["off"]
                if self.page < 7:
                    path = self.fader_path(col)
                    value = self.fader_display_value(col) if path else None
                    if value is None and path:
                        # Unknown value: don't misrepresent it as zero.
                        color = COLORS["white"] if row == 7 else COLORS["off"]
                    elif value is not None:
                        bars = fader_bar_count(value)
                        if bars == 1 and row == 7:
                            # Red bottom pad indicates the real 0.0 minimum,
                            # distinct from an active fader and from Mute.
                            color = COLORS["red"]
                        elif bars > 1 and (8 - row) <= bars:
                            color = COLORS["yellow"] if col == 0 else COLORS["green"]
                elif row < 4:
                    ch = (row % 2) * 8 + col + 1
                    if row < 2:
                        value = self.get(f"/ch/{ch:02d}/mix/on")
                        color = (COLORS["white"] if value is None else
                                 COLORS["green"] if int(value) == 1 else COLORS["red"])
                    else:
                        value = self.get(f"/ch/{ch:02d}/preamp/rtnsw")
                        color = (COLORS["white"] if value is None else
                                 COLORS["blue"] if int(value) == 1 else COLORS["yellow"])
                self.set_led("note", pad_note(row, col), color)

        for i, button in enumerate(RIGHT_BUTTONS):
            self.set_led("cc", button,
                         COLORS["purple"] if i == self.page else COLORS["green_dim"])
        self.set_led("cc", TOP_LEFT,
                     COLORS["blue"] if self.bank > 0 else COLORS["off"])
        self.set_led("cc", TOP_RIGHT,
                     COLORS["blue"] if self.bank < 2 else COLORS["off"])
        # Dim other physical top buttons; these are not used by this app.
        for button in (91, 92, 95, 96, 97, 98):
            self.set_led("cc", button, COLORS["off"])
        self.set_led("cc", 99, COLORS["green"] if self.info_ok else COLORS["red"])
        self.last_draw = time.monotonic()

    def process_osc(self):
        changed = False
        for _ in range(256):
            try:
                payload, sender = self.sock.recvfrom(65535)
            except BlockingIOError:
                break
            except OSError as exc:
                print(f"OSC socket error: {exc}", file=sys.stderr)
                break
            if sender[0] != self.args.host:
                continue
            try:
                message = OscMessage(payload)
            except Exception:
                continue
            if message.address == "/xinfo":
                self.last_xinfo = time.monotonic()
                if not self.info_ok:
                    print("[MR18 已連線 / 重新連線]", list(message.params), flush=True)
                    # Invalidate stale values from before the outage.
                    self.cache.clear()
                    self.pending_readback.clear()
                    self.info_ok = True
                    self.connected_at = self.last_xinfo
                    self.refresh_queries()
                    changed = True
                continue
            # Ignore older, possibly delayed packets when the device is
            # considered offline. An /xinfo handshake clears this condition.
            if not self.info_ok:
                continue
            if len(message.params) == 1 and isinstance(message.params[0], (float, int)):
                current = self.cache.get(message.address)
                new_value = message.params[0]
                if current is None or current[0] != new_value:
                    changed = True
                self.cache[message.address] = (new_value, time.monotonic())
        return changed

    def check_mixer_timeout(self, now):
        # Send actual /xinfo probes; /xremote is only a subscription keepalive.
        if now - self.last_probe >= 3.0:
            self.send_osc("/xinfo")
            self.last_probe = now
        if self.info_ok and now - self.last_xinfo > 10.0:
            print("[MR18 失聯] 超過 10 秒沒有 /xinfo 回覆；暫停控制並等待網路恢復", flush=True)
            self.info_ok = False
            self.cache.clear()
            self.pending_readback.clear()
            self.draw_dirty = True

    def handle_grid(self, row, col):
        if self.page < 7:
            path = self.fader_path(col)
            if path is None:
                return
            # 8 steps: bottom 0.0 (= absolute minimum); top 0.75 (= 0 dB).
            value = FADER_STEPS[7 - row]
            if self.send_osc(path, float(value), writing=True):
                now = time.monotonic()
                self.cache[path] = (float(value), now)
                if col > 0:
                    ch = self.bank * 7 + col
                    partner = self.main_linked_partner(ch)
                    if partner is not None:
                        # Optimistic display consistency only, NO second write.
                        partner_path = f'/ch/{partner:02d}/mix/fader'
                        self.cache[partner_path] = (float(value), now)
                # Re-read after the MR18 has had time to apply/link the value.
                self.pending_readback[path] = now + 0.18
                if col > 0 and self.page == 0 and partner is not None:
                    self.pending_readback[f'/ch/{partner:02d}/mix/fader'] = now + 0.18
            return

        if row >= 4:
            return
        ch = (row % 2) * 8 + col + 1
        path = (f"/ch/{ch:02d}/mix/on" if row < 2 else
                f"/ch/{ch:02d}/preamp/rtnsw")
        current = self.get(path)
        if current is None:
            print(f"CH{ch} 尚未讀到狀態，先查詢 {path}；收到後再按一次。")
            self.send_osc(path)
            return
        next_value = 1 - int(current)
        if self.send_osc(path, next_value, writing=True):
            self.cache[path] = (next_value, time.monotonic())
            self.send_osc(path)  # verify via GET

    def handle_midi(self, message):
        if message.type == "note_on" and message.velocity > 0:
            note = message.note
            col = (note % 10) - 1
            row = 8 - note // 10
            if 0 <= row < 8 and 0 <= col < 8:
                self.handle_grid(row, col)
                return True
        if message.type == "control_change" and message.value > 0:
            cc = message.control
            if cc == TOP_LEFT and self.bank > 0:
                self.bank -= 1
                print(f"[Bank] CH {self.bank * 7 + 1}–{min(16, self.bank * 7 + 7)}")
                self.refresh_queries()
                return True
            if cc == TOP_RIGHT and self.bank < 2:
                self.bank += 1
                print(f"[Bank] CH {self.bank * 7 + 1}–{min(16, self.bank * 7 + 7)}")
                self.refresh_queries()
                return True
            if cc in RIGHT_BUTTONS:
                self.page = RIGHT_BUTTONS.index(cc)
                page_name = "Main" if self.page == 0 else (
                    "Settings" if self.page == 7 else f"Aux {self.page}")
                print(f"[Page] {page_name}")
                self.refresh_queries()
                return True
        return False

    def run(self):
        print("右側：Main / Aux 1..6 / Settings；上方 ◀ ▶ 切 CH Bank")
        print("左側第一條：Main LR 或目前選擇的 Aux Master；其他七條：Input CH")
        print("8 階音量：底部絕對最低（紅燈）→ -60/-45/-30/-20/-10/-5/0 dB")
        print("Main 頁：依 MR18 的 Channel Link + Fader Link 設定同步 Stereo Pair 的 LED")
        print("Settings：第1/2排 CH1..16 Mute；第3/4排 CH1..16 USB/Line")
        print("控制模式：" + ("真實操作 MR18 (--arm)" if self.args.arm else "僅預覽，不會修改 MR18"))
        print("自動重連：Launchpad USB、MR18 OSC（含開機時裝置尚未就緒）")
        print("Ctrl+C 離開。")
        try:
            while True:
                now = time.monotonic()
                self.ensure_midi(now)
                self.check_mixer_timeout(now)
                if now - self.last_keepalive >= 6:
                    self.send_osc("/xremote")
                    self.last_keepalive = now
                # Poll MR18 current values; never push stale values to mixer.
                if self.info_ok and now - self.last_query >= 4:
                    self.refresh_queries()
                if self.info_ok:
                    for path, due in tuple(self.pending_readback.items()):
                        if now >= due:
                            self.send_osc(path)
                            del self.pending_readback[path]
                if self.process_osc():
                    self.draw_dirty = True
                if self.midi_in is not None:
                    try:
                        for message in self.midi_in.iter_pending():
                            if self.handle_midi(message):
                                self.draw_dirty = True
                    except Exception as exc:
                        self.close_midi(f"讀取 MIDI 失敗：{exc}")
                if self.midi_out is not None and self.draw_dirty and now - self.last_draw >= 0.03:
                    try:
                        self.draw()
                        self.draw_dirty = False
                    except Exception as exc:
                        self.close_midi(f"寫入 LED 失敗：{exc}")
                time.sleep(0.015)
        except KeyboardInterrupt:
            print("\n已停止。")
        finally:
            try:
                if self.midi_out is not None:
                    self.send_sysex(14, 0)  # Restore Live Mode on clean stop.
            except Exception:
                pass
            self.close_midi()
            self.sock.close()


def main():
    parser = argparse.ArgumentParser(description="Launchpad Mini MK3 -> MR18 controller")
    parser.add_argument("--host", default="10.3.255.251", help="MR18 OSC IP")
    parser.add_argument("--port", type=int, default=10024, help="MR18 OSC UDP port")
    parser.add_argument("--arm", action="store_true", help="Allow actually changing MR18 parameters")
    parser.add_argument("--list-ports", action="store_true", help="List available MIDI ports and exit")
    parser.add_argument("--input", help="Exact mido input port name (avoid with USB replug)")
    parser.add_argument("--output", help="Exact mido output port name (avoid with USB replug)")
    args = parser.parse_args()
    mido.set_backend("mido.backends.rtmidi/LINUX_ALSA" if sys.platform.startswith("linux") else "mido.backends.rtmidi")
    if args.list_ports:
        print("MIDI INPUTS:")
        for name in mido.get_input_names():
            print("  ", name)
        print("MIDI OUTPUTS:")
        for name in mido.get_output_names():
            print("  ", name)
        return
    try:
        Controller(args).run()
    except (RuntimeError, OSError) as exc:
        sys.exit(f"控制程式遇到無法恢復的錯誤：{exc}")


if __name__ == "__main__":
    main()
