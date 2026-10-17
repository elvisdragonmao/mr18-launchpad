// Browser simulation of mr18_launchpad.py: same page/bank/fader logic and the
// same log lines, driven by a fake mixer instead of OSC. Also hosts the
// step-by-step practice tour.
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
  var CONNECTED_LINE = "[Launchpad 已連接] Input=Launchpad Mini MK3 LPMiniMK3 MI 28:1; Output=Launchpad Mini MK3 LPMiniMK3 MI 28:1";
  var MIXER_LINE = "[MR18 已連線 / 重新連線] ['10.3.255.251', 'MR18-82-ED-A9', 'MR18', '1.26']";

  function pad2(n) { return n < 10 ? "0" + n : String(n); }
  function fmtFloat(v) { return Number.isInteger(v) ? v.toFixed(1) : String(v); }

  // The "real" MR18. The controller only knows what it has read into cache.
  var mixer = {};
  function seed() {
    var ch = [0.75, 0.625, 0.5, 0.75, 0.375, 0.0, 0.25, 0.625,
              0.5, 0.15625, 0.5, 0.375, 0.0625, 0.5, 0.625, 0.625];
    mixer = {};
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
  }
  seed();

  var state = { page: 0, bank: 0, online: true, usb: true };
  var cache = Object.assign({}, mixer);

  var deviceEl = document.getElementById("device");
  var gridEl = document.getElementById("grid");
  var hintEl = document.getElementById("hint");
  var logEl = document.getElementById("log");
  var mixerBox = document.getElementById("sim-mixer");
  var usbBox = document.getElementById("sim-usb");
  var keys = [];  // keys[row][col], row 0 = top buttons, col 8 = right column
  var logLines = [];
  var replugTimer = null;

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
  function bankText(bank) {
    if (bank === undefined) bank = state.bank;
    return "CH " + (bank * 7 + 1) + "–" + Math.min(16, bank * 7 + 7);
  }

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
      tour.check();
    });
  }

  mixerBox.addEventListener("change", function () {
    state.online = mixerBox.checked;
    if (!state.online) {
      log("[MR18 失聯] 超過 10 秒沒有 /xinfo 回覆；暫停控制並等待網路恢復");
      cache = {};
    } else {
      log(MIXER_LINE);
      refresh();
    }
    draw();
    tour.check();
  });

  usbBox.addEventListener("change", function () {
    clearTimeout(replugTimer);
    if (!usbBox.checked) {
      state.usb = false;
      log("[Launchpad 斷線] MIDI Port 消失；插回 USB 後會自動重連");
      log("[等待 Launchpad] 尚未找到 Mini MK3，插入 USB 後會自動連接。");
      draw();
      tour.unplugged = true;
      tour.check();
      return;
    }
    // The real controller rescans MIDI ports every 2 seconds.
    replugTimer = setTimeout(function () {
      state.usb = true;
      log(CONNECTED_LINE);
      draw();
      tour.check();
    }, 1200);
  });

  function resetSim() {
    clearTimeout(replugTimer);
    seed();
    cache = Object.assign({}, mixer);
    state.page = 0;
    state.bank = 0;
    state.online = true;
    state.usb = true;
    mixerBox.checked = true;
    usbBox.checked = true;
    logLines = [];
    hintEl.textContent = "指向任何一顆按鍵看它的功能";
    log("控制模式：真實操作 MR18 (--arm)");
    log(CONNECTED_LINE);
    log(MIXER_LINE);
    draw();
  }

  // ---- practice tour ----------------------------------------------------

  // Grid row (1 = top pad row) for a fader step, by dB label.
  function rowFor(db) { return 8 - STEP_DB.indexOf(db); }
  function val(path) { return mixer[path]; }

  var STEPS = [
    {
      chapter: "推桿",
      task: "把 CH 1 調到 −10 dB",
      detail: "第 2 欄是 CH 1。每一欄由上往下是 0、−5、−10 … dB，按這欄從上面數來第 3 格。",
      key: [rowFor("−10"), 1], page: 0, bank: 0,
      done: function () { return val("/ch/01/mix/fader") === 0.5; },
      after: "綠色長條變成從下面亮到第 3 格。長條多高，推桿就推到哪裡。日誌裡的 [送出 OSC] 就是程式實際送給 MR18 的指令。"
    },
    {
      chapter: "推桿",
      task: "把 CH 1 拉到底",
      detail: "按第 2 欄最下面那一格。",
      key: [rowFor("−∞"), 1], page: 0, bank: 0,
      done: function () { return val("/ch/01/mix/fader") === 0; },
      after: "只剩最下面一格亮紅燈：這條推桿拉到底（−∞），CH 1 沒有聲音送到 Main。"
    },
    {
      chapter: "推桿",
      task: "把 Main LR 調到 0 dB",
      detail: "最左邊的黃色欄是 Master，在 Main 頁就是總音量。按這欄最上面那一格。",
      key: [rowFor("0"), 0], page: 0,
      done: function () { return val("/lr/mix/fader") === 0.75; },
      after: "黃色整欄亮滿就是 0 dB。Master 一律是黃色，聲道是綠色，一眼就分得出來。"
    },
    {
      chapter: "換聲道",
      task: "切到 CH 8–14",
      detail: "一次只放得下 7 個聲道。按上方亮藍色的 ▶。",
      key: [0, 3],
      done: function () { return state.bank === 1; },
      after: "第 2–8 欄現在是 CH 8 到 CH 14。◀ ▶ 都亮藍色，表示兩個方向都還能切。黃色 Master 欄不會跟著換。"
    },
    {
      chapter: "換聲道",
      task: "把 CH 10 調到 −20 dB",
      detail: "這一組從第 2 欄的 CH 8 開始，所以 CH 10 在第 4 欄。−20 dB 是從上面數來第 4 格。",
      key: [rowFor("−20"), 3], page: 0, bank: 1,
      done: function () { return val("/ch/10/mix/fader") === 0.375; },
      after: "按法一樣，只是換了一組聲道。"
    },
    {
      chapter: "換聲道",
      task: "回到 CH 1–7",
      detail: "按 ◀。",
      key: [0, 2],
      done: function () { return state.bank === 0; },
      after: "回到第一組。剛才拉到底的 CH 1 還是亮紅燈，切換 Bank 不會改到任何數值。"
    },
    {
      chapter: "Aux",
      task: "切到 Aux 1",
      detail: "右側那一排是頁面：第 1 顆是 Main，第 2 到第 7 顆是 Aux 1 到 Aux 6。按第 2 顆。",
      key: [2, 8],
      done: function () { return state.page === 1; },
      after: "亮紫色的就是目前的頁面。現在每一欄調的是各聲道「送到 Aux 1 的量」，例如舞台上的監聽喇叭；黃色欄變成 Aux 1 的總音量。"
    },
    {
      chapter: "Aux",
      task: "把 CH 2 送到 Aux 1 的量調到 −5 dB",
      detail: "CH 2 在第 3 欄，−5 dB 是從上面數來第 2 格。",
      key: [rowFor("−5"), 2], page: 1, bank: 0,
      done: function () { return val("/ch/02/mix/01/level") === 0.625; },
      after: "這只改了 CH 2 在 Aux 1 裡的大小，觀眾聽到的 Main 不受影響。"
    },
    {
      chapter: "Aux",
      task: "回到 Main",
      detail: "按右側第 1 顆。",
      key: [1, 8],
      done: function () { return state.page === 0; },
      after: "推桿又顯示 Main 的數值了。"
    },
    {
      chapter: "Settings",
      task: "進入 Settings 頁",
      detail: "按右下角的 Stop / Solo / Mute。",
      key: [8, 8],
      done: function () { return state.page === 7; },
      after: "Settings 頁只用上面四排：第 1、2 排是 Mute，第 3、4 排是輸入來源。"
    },
    {
      chapter: "Settings",
      task: "把 CH 3 Mute",
      detail: "第 1 排是 CH 1–8，綠色表示聲道開著。按第 1 排第 3 格。",
      key: [1, 2], page: 7,
      done: function () { return val("/ch/03/mix/on") === 0; },
      after: "變成紅色，CH 3 被 Mute 了。"
    },
    {
      chapter: "Settings",
      task: "取消 CH 3 的 Mute",
      detail: "同一格再按一次。",
      key: [1, 2], page: 7,
      done: function () { return val("/ch/03/mix/on") === 1; },
      after: "按一下切換，再按一下切回來。"
    },
    {
      chapter: "Settings",
      task: "把 CH 9 的輸入改成 USB",
      detail: "第 4 排是 CH 9–16 的輸入來源。黃色是 Line（接在 MR18 上的線材），藍色是 USB（電腦播出的聲音）。按第 4 排第 1 格。",
      key: [4, 0], page: 7,
      done: function () { return val("/ch/09/preamp/rtnsw") === 1; },
      after: "變成藍色，CH 9 現在收的是電腦經由 USB 送進來的聲音。"
    },
    {
      chapter: "斷線",
      task: "模擬 MR18 斷線",
      detail: "取消勾選下方的「MR18 連線」。",
      control: "sim-mixer",
      done: function () { return !state.online; },
      after: "右上角變紅，方格變成白色：程式不知道 MR18 現在的數值，這時按任何格都不會送出去。（實際上要 10 秒沒回應才會判定斷線。）"
    },
    {
      chapter: "斷線",
      task: "恢復 MR18 連線",
      detail: "把「MR18 連線」勾回來。",
      control: "sim-mixer",
      done: function () { return state.online; },
      after: "程式重新讀取 MR18 的數值，燈號回到正確狀態。斷線前記住的數值不會被寫回去。"
    },
    {
      chapter: "斷線",
      task: "拔掉 Launchpad 再插回去",
      detail: "取消勾選「Launchpad USB」，等燈全暗，再勾回來。",
      control: "sim-usb",
      enter: function () { tour.unplugged = false; },
      done: function () { return tour.unplugged && state.usb; },
      after: "插回去約 2 秒內自動接上，原本的頁面和 Bank 都還在，不用重開程式。"
    }
  ];

  var tourEl = document.getElementById("tour");
  var idleEl = document.getElementById("tour-idle");
  var activeEl = document.getElementById("tour-active");
  var chapterEl = document.getElementById("tour-chapter");
  var countEl = document.getElementById("tour-count");
  var barEl = document.getElementById("tour-bar");
  var taskEl = document.getElementById("tour-task");
  var detailEl = document.getElementById("tour-detail");
  var prevBtn = tourEl.querySelector('[data-tour="prev"]');
  var nextBtn = tourEl.querySelector('[data-tour="next"]');
  var ring = document.createElement("div");
  ring.className = "target-ring";
  ring.hidden = true;
  deviceEl.appendChild(ring);

  var tour = {
    active: false,
    index: 0,
    completed: false,
    unplugged: false,

    start: function () {
      resetSim();
      this.active = true;
      idleEl.hidden = true;
      activeEl.hidden = false;
      tourEl.classList.add("is-active");
      this.go(0);
      var top = tourEl.getBoundingClientRect().top;
      if (top < 52 || top > window.innerHeight * 0.5) {
        tourEl.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },

    stop: function () {
      this.active = false;
      idleEl.hidden = false;
      activeEl.hidden = true;
      tourEl.classList.remove("is-active");
      this.highlight(null, null);
    },

    go: function (i) {
      this.index = i;
      this.completed = false;
      if (i >= STEPS.length) { this.finish(); return; }
      var step = STEPS[i];
      if (step.enter) step.enter();
      chapterEl.textContent = step.chapter;
      countEl.textContent = (i + 1) + " / " + STEPS.length;
      barEl.style.width = (i / STEPS.length * 100) + "%";
      taskEl.textContent = step.task;
      prevBtn.hidden = i === 0;
      this.check();
    },

    // Steps that act on a pad first need the right page and bank.
    detour: function (step) {
      if (step.page !== undefined && state.page !== step.page) {
        return { key: [step.page + 1, 8], text: "先切回 " + PAGE_NAMES[step.page] + " 頁：按右側第 " + (step.page + 1) + " 顆。" };
      }
      if (step.bank !== undefined && state.bank !== step.bank) {
        var left = state.bank > step.bank;
        return { key: [0, left ? 2 : 3], text: "先按 " + (left ? "◀" : "▶") + " 切回 " + bankText(step.bank) + "。" };
      }
      return null;
    },

    check: function () {
      if (!this.active || this.index >= STEPS.length) return;
      var step = STEPS[this.index];
      if (!this.completed && step.done()) this.completed = true;
      detailEl.classList.toggle("is-done", this.completed);
      nextBtn.textContent = this.completed ? "下一步" : "跳過";
      nextBtn.classList.toggle("primary", this.completed);
      if (this.completed) {
        detailEl.textContent = step.after;
        this.highlight(null, null);
        nextBtn.focus({ preventScroll: true });
        return;
      }
      var d = this.detour(step);
      detailEl.textContent = d ? d.text : step.detail;
      this.highlight(d ? d.key : step.key, step.control);
    },

    finish: function () {
      chapterEl.textContent = "完成";
      countEl.textContent = STEPS.length + " / " + STEPS.length;
      barEl.style.width = "100%";
      taskEl.textContent = "練習完成";
      detailEl.textContent = "實體 Launchpad 的按法跟這裡完全一樣。之後忘記了，指向任何一顆按鍵就會顯示它的功能。";
      detailEl.classList.add("is-done");
      nextBtn.textContent = "再練一次";
      nextBtn.classList.add("primary");
      prevBtn.hidden = true;
      this.highlight(null, null);
    },

    highlight: function (key, control) {
      document.querySelectorAll(".sim-controls label.is-target").forEach(function (l) { l.classList.remove("is-target"); });
      if (control) document.getElementById(control).closest("label").classList.add("is-target");
      this.targetKey = key;
      this.placeRing();
    },

    placeRing: function () {
      var key = this.targetKey;
      if (!key) { ring.hidden = true; return; }
      var el = keys[key[0]][key[1]];
      ring.style.left = el.offsetLeft + "px";
      ring.style.top = el.offsetTop + "px";
      ring.style.width = (el.offsetWidth + 12) + "px";
      ring.style.height = (el.offsetHeight + 12) + "px";
      ring.hidden = false;
    }
  };

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-tour]");
    if (!b) return;
    var action = b.dataset.tour;
    if (action === "start") { e.preventDefault(); tour.start(); }
    else if (action === "exit") tour.stop();
    else if (action === "prev") tour.go(Math.max(0, tour.index - 1));
    else if (action === "next") {
      if (tour.index >= STEPS.length) tour.start();
      else tour.go(tour.index + 1);
    }
  });
  window.addEventListener("resize", function () { if (tour.active) tour.placeRing(); });

  build();
  resetSim();

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
