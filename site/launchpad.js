// Browser simulation of mr18_launchpad.py: same page/bank/fader logic and the
// same log lines, driven by a fake mixer instead of OSC.
(function () {
  "use strict";

  var FADER_STEPS = [0.0, 0.0625, 0.15625, 0.25, 0.375, 0.5, 0.625, 0.75];
  var STEP_DB = ["−∞", "−60", "−45", "−30", "−20", "−10", "−5", "0"];
  var MIDPOINTS = FADER_STEPS.slice(1).map(function (b, i) { return (FADER_STEPS[i] + b) / 2; });
  var TOP_LABELS = ["▲", "▼", "◀", "▶", "Session", "Drums", "Keys", "User"];
  var PAGE_NAMES = ["Main", "Aux 1", "Aux 2", "Aux 3", "Aux 4", "Aux 5", "Aux 6", "Settings"];
  var LED = {
    off: null, white: "--led-white", red: "--led-red", yellow: "--led-yellow",
    green: "--led-green", greenDim: "--led-green-dim", blue: "--led-blue", purple: "--led-purple"
  };

  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtFloat(v) { return Number.isInteger(v) ? v.toFixed(1) : String(v); }

  // The "real" MR18. The controller only knows what it has read into cache.
  var mixer = {};
  (function seed() {
    var ch = [0.75, 0.625, 0.5, 0.75, 0.375, 0.0, 0.25, 0.625,
              0.5, 0.15625, 0.5, 0.375, 0.0625, 0.5, 0.625, 0.625];
    mixer["/lr/mix/fader"] = 0.625;
    for (var c = 1; c <= 16; c++) {
      mixer["/ch/" + pad2(c) + "/mix/fader"] = ch[c - 1];
      mixer["/ch/" + pad2(c) + "/mix/on"] = (c === 6 || c === 13) ? 0 : 1;
      mixer["/ch/" + pad2(c) + "/preamp/rtnsw"] = c >= 15 ? 1 : 0;
      for (var b = 1; b <= 6; b++) {
        mixer["/ch/" + pad2(c) + "/mix/" + pad2(b) + "/level"] = FADER_STEPS[(c * 3 + b * 5) % 8];
      }
    }
    for (var bus = 1; bus <= 6; bus++) mixer["/bus/" + bus + "/mix/fader"] = FADER_STEPS[4 + bus % 4];
  })();

  var state = { page: 0, bank: 0, online: true, usb: true };
  var cache = Object.assign({}, mixer);

  var gridEl = document.getElementById("grid");
  var hintEl = document.getElementById("hint");
  var logEl = document.getElementById("log");
  var keys = [];  // keys[row][col], row 0 = top buttons, col 8 = right column
  var logLines = [];

  function log(line) {
    logLines.push(line);
    if (logLines.length > 40) logLines.shift();
    logEl.textContent = logLines.join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function barCount(value) {
    value = Math.max(0, Math.min(1, value));
    if (value <= 1e-7) return 1;
    var i = 0;
    while (i < MIDPOINTS.length && MIDPOINTS[i] <= value) i++;
    return Math.max(2, Math.min(8, i + 1));
  }

  function masterPath() { return state.page === 0 ? "/lr/mix/fader" : "/bus/" + state.page + "/mix/fader"; }
  function channelFor(col) { return state.bank * 7 + col; }
  function faderPath(col) {
    if (col === 0) return masterPath();
    var ch = channelFor(col);
    if (ch > 16) return null;
    return state.page === 0 ? "/ch/" + pad2(ch) + "/mix/fader" : "/ch/" + pad2(ch) + "/mix/" + pad2(state.page) + "/level";
  }
  function bankText() { return "CH " + (state.bank * 7 + 1) + "–" + Math.min(16, state.bank * 7 + 7); }

  function padColor(row, col) {
    if (state.page < 7) {
      var path = faderPath(col);
      if (!path) return LED.off;
      var value = cache[path];
      if (value === undefined) return row === 7 ? LED.white : LED.off;
      var bars = barCount(value);
      if (bars === 1) return row === 7 ? LED.red : LED.off;
      return (8 - row) <= bars ? (col === 0 ? LED.yellow : LED.green) : LED.off;
    }
    if (row >= 4) return LED.off;
    var ch = (row % 2) * 8 + col + 1;
    if (row < 2) {
      var on = cache["/ch/" + pad2(ch) + "/mix/on"];
      return on === undefined ? LED.white : on === 1 ? LED.green : LED.red;
    }
    var usb = cache["/ch/" + pad2(ch) + "/preamp/rtnsw"];
    return usb === undefined ? LED.white : usb === 1 ? LED.blue : LED.yellow;
  }

  function setLit(el, color) {
    if (!state.usb) color = null;
    el.classList.toggle("lit", !!color);
    if (color) el.style.setProperty("--c", "var(" + color + ")");
    else el.style.removeProperty("--c");
  }

  function draw() {
    for (var r = 1; r <= 8; r++) {
      for (var c = 0; c < 8; c++) setLit(keys[r][c], padColor(r - 1, c));
      setLit(keys[r][8], (r - 1) === state.page ? LED.purple : LED.greenDim);
    }
    for (var t = 0; t < 8; t++) {
      var color = LED.off;
      if (t === 2 && state.bank > 0) color = LED.blue;
      if (t === 3 && state.bank < 2) color = LED.blue;
      setLit(keys[0][t], color);
    }
    setLit(keys[0][8], state.online ? LED.green : LED.red);
  }

  function refresh() {
    // Stand-in for refresh_queries(): an OSC GET round trip.
    if (!state.online) return;
    setTimeout(function () {
      if (!state.online) return;
      Object.assign(cache, mixer);
      draw();
    }, 120);
  }

  function pressPad(row, col) {
    if (state.page < 7) {
      var path = faderPath(col);
      if (!path) return;
      var value = FADER_STEPS[7 - row];
      if (!state.online) { log("[拒絕寫入：MR18 未連線] " + path + " = " + fmtFloat(value)); return; }
      mixer[path] = value;
      cache[path] = value;
      log("[送出 OSC] " + path + " = " + fmtFloat(value));
      return;
    }
    if (row >= 4) return;
    var ch = (row % 2) * 8 + col + 1;
    var p = row < 2 ? "/ch/" + pad2(ch) + "/mix/on" : "/ch/" + pad2(ch) + "/preamp/rtnsw";
    if (cache[p] === undefined) { log("CH" + ch + " 尚未讀到狀態，先查詢 " + p + "；收到後再按一次。"); return; }
    var next = 1 - cache[p];
    if (!state.online) { log("[拒絕寫入：MR18 未連線] " + p + " = " + next); return; }
    mixer[p] = next;
    cache[p] = next;
    log("[送出 OSC] " + p + " = " + next);
  }

  function pressTop(i) {
    if (i === 2 && state.bank > 0) state.bank--;
    else if (i === 3 && state.bank < 2) state.bank++;
    else return;
    log("[Bank] " + bankText());
    refresh();
  }

  function pressSide(i) {
    state.page = i;
    log("[Page] " + PAGE_NAMES[i]);
    refresh();
  }

  function describe(row, col) {
    if (!state.usb) return "Launchpad 沒有接上，按鍵沒有作用";
    if (row === 0) {
      if (col === 8) return state.online ? "狀態燈：綠色，MR18 連線中" : "狀態燈：紅色，MR18 沒有回應，暫停寫入";
      if (col === 2) return state.bank > 0 ? "◀ 換到前一組聲道（目前 " + bankText() + "）" : "◀ 已經是第一組聲道（" + bankText() + "）";
      if (col === 3) return state.bank < 2 ? "▶ 換到下一組聲道（目前 " + bankText() + "）" : "▶ 已經是最後一組聲道（" + bankText() + "）";
      return TOP_LABELS[col] + "：不使用";
    }
    var r = row - 1;
    if (col === 8) return "切換到 " + PAGE_NAMES[r] + " 頁" + (r === state.page ? "（目前頁面）" : "");
    if (state.page === 7) {
      if (r >= 4) return "Settings 頁不使用這一排";
      var ch = (r % 2) * 8 + col + 1;
      var v;
      if (r < 2) {
        v = cache["/ch/" + pad2(ch) + "/mix/on"];
        return "CH " + ch + " Mute · 目前" + (v === undefined ? "未知" : v === 1 ? "開啟" : "Mute") + " · 按一下切換";
      }
      v = cache["/ch/" + pad2(ch) + "/preamp/rtnsw"];
      return "CH " + ch + " 輸入來源 · 目前" + (v === undefined ? "未知" : v === 1 ? " USB" : " Line") + " · 按一下切換";
    }
    var target = STEP_DB[7 - r] + " dB";
    if (col === 0) return (state.page === 0 ? "Main LR" : PAGE_NAMES[state.page] + " Master") + " · 按這格設為 " + target;
    var chn = channelFor(col);
    if (chn > 16) return "這組沒有第 " + chn + " 聲道";
    return "CH " + chn + (state.page === 0 ? "" : " → " + PAGE_NAMES[state.page]) + " · 按這格設為 " + target;
  }

  function build() {
    for (var row = 0; row < 9; row++) {
      keys[row] = [];
      for (var col = 0; col < 9; col++) {
        var el = document.createElement("button");
        el.type = "button";
        el.className = "key";
        if (row === 0 && col === 8) {
          el.classList.add("logo");
          el.setAttribute("aria-label", "狀態燈");
        } else if (row === 0) {
          el.classList.add("btnkey");
          if (col < 4) el.classList.add("arrow");
          el.textContent = TOP_LABELS[col];
        } else if (col === 8) {
          el.classList.add("btnkey");
          if (row === 8) el.innerHTML = "Stop<br>Solo<br>Mute";
          else el.innerHTML = '<span class="arrow">&gt;</span>';
          el.setAttribute("aria-label", PAGE_NAMES[row - 1] + " 頁");
        } else {
          el.classList.add("pad");
          if (row === 4 && col === 3) el.classList.add("n-br");
          if (row === 4 && col === 4) el.classList.add("n-bl");
          if (row === 5 && col === 3) el.classList.add("n-tr");
          if (row === 5 && col === 4) el.classList.add("n-tl");
        }
        el.dataset.row = row;
        el.dataset.col = col;
        gridEl.appendChild(el);
        keys[row][col] = el;
      }
    }

    function target(e) { return e.target.closest(".key"); }
    function showHint(e) {
      var k = target(e);
      if (k) hintEl.textContent = describe(+k.dataset.row, +k.dataset.col);
    }
    gridEl.addEventListener("mouseover", showHint);
    gridEl.addEventListener("focusin", showHint);
    gridEl.addEventListener("click", function (e) {
      var k = target(e);
      if (!k || !state.usb) return;
      var row = +k.dataset.row, col = +k.dataset.col;
      if (row === 0 && col < 8) pressTop(col);
      else if (row > 0 && col === 8) pressSide(row - 1);
      else if (row > 0) pressPad(row - 1, col);
      draw();
      hintEl.textContent = describe(row, col);
    });
  }

  document.getElementById("sim-mixer").addEventListener("change", function (e) {
    state.online = e.target.checked;
    if (!state.online) {
      log("[MR18 失聯] 超過 10 秒沒有 /xinfo 回覆；暫停控制並等待網路恢復");
      cache = {};
    } else {
      log("[MR18 已連線 / 重新連線] ['10.3.255.251', 'MR18-82-ED-A9', 'MR18', '1.26']");
      refresh();
    }
    draw();
  });

  var replugTimer = null;
  document.getElementById("sim-usb").addEventListener("change", function (e) {
    clearTimeout(replugTimer);
    if (!e.target.checked) {
      state.usb = false;
      log("[Launchpad 斷線] MIDI Port 消失；插回 USB 後會自動重連");
      log("[等待 Launchpad] 尚未找到 Mini MK3，插入 USB 後會自動連接。");
      draw();
      return;
    }
    // The real controller rescans MIDI ports every 2 seconds.
    replugTimer = setTimeout(function () {
      state.usb = true;
      log("[Launchpad 已連接] Input=Launchpad Mini MK3 LPMiniMK3 MI 28:1; Output=Launchpad Mini MK3 LPMiniMK3 MI 28:1");
      draw();
    }, 1200);
  });

  build();
  log("控制模式：真實操作 MR18 (--arm)");
  log("[Launchpad 已連接] Input=Launchpad Mini MK3 LPMiniMK3 MI 28:1; Output=Launchpad Mini MK3 LPMiniMK3 MI 28:1");
  log("[MR18 已連線 / 重新連線] ['10.3.255.251', 'MR18-82-ED-A9', 'MR18', '1.26']");
  draw();

  // Copy buttons on command blocks.
  document.querySelectorAll(".prose pre:not(.output)").forEach(function (pre) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "複製";
    btn.addEventListener("click", function () {
      var text = pre.querySelector("code").textContent;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = "已複製";
        setTimeout(function () { btn.textContent = "複製"; }, 1500);
      });
    });
    pre.appendChild(btn);
  });
})();
