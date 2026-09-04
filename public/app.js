const socket = io({ transports: ["websocket", "polling"] });

const $ = (selector) => document.querySelector(selector);
const entryScreen = $("#entry-screen");
const gameScreen = $("#game-screen");
const nameInput = $("#player-name");
const codeInput = $("#room-code");
const capacityInput = $("#room-capacity");
const modeInput = $("#room-mode");
const boardSvg = $("#game-board");
const toast = $("#toast");

const seatShort = { north: "北", east: "东", south: "南", west: "西" };
const stealthSeatColors = {
  north: "#70757a",
  east: "#6b4c35",
  south: "#274634",
  west: "#263a55",
};
let boardMeta = null;
let state = null;
let selected = null;
let awaitingRoom = false;
let toastTimer = null;
let stealthMode = localStorage.getItem("junqi-stealth") === "1";

const savedName = localStorage.getItem("junqi-name");
if (savedName) nameInput.value = savedName;
const invitedCode = new URLSearchParams(location.search).get("room");
if (invitedCode) codeInput.value = invitedCode.toUpperCase().slice(0, 6);

function getSession() {
  try { return JSON.parse(localStorage.getItem("junqi-session")); }
  catch { return null; }
}

function setSession(session) {
  localStorage.setItem("junqi-session", JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem("junqi-session");
}

function showToast(message, kind = "error") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show ${kind === "success" ? "success" : ""}`;
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 2800);
}

function applyStealthMode() {
  document.body.classList.toggle("stealth-mode", stealthMode);
  const button = $("#stealth-button");
  button.textContent = stealthMode ? "退出隐蔽" : "隐蔽模式";
  button.setAttribute("aria-pressed", String(stealthMode));
}

function seatColor(seat) {
  return stealthMode ? stealthSeatColors[seat] : boardMeta?.seatColors[seat];
}

applyStealthMode();

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function playerName() {
  const value = nameInput.value.trim().slice(0, 16) || "玩家";
  localStorage.setItem("junqi-name", value);
  return value;
}

function updateModeInput() {
  modeInput.disabled = capacityInput.value !== "4";
  if (modeInput.disabled) modeInput.value = "ffa";
}

capacityInput.addEventListener("change", updateModeInput);
updateModeInput();

$("#create-form").addEventListener("submit", (event) => {
  event.preventDefault();
  awaitingRoom = true;
  socket.emit("create-room", {
    name: playerName(),
    capacity: Number(capacityInput.value),
    mode: modeInput.value,
  });
});

$("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 6) return showToast("请输入六位房间码");
  awaitingRoom = true;
  socket.emit("join-room", { name: playerName(), code });
});

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
});

socket.on("connect", () => {
  $("#connection-dot").classList.add("online");
  $("#connection-text").textContent = "服务器已连接";
  const session = getSession();
  const inviteMatches = !invitedCode || invitedCode.toUpperCase() === session?.code;
  if (session?.code && session?.token && !state && inviteMatches) {
    awaitingRoom = true;
    socket.emit("join-room", session);
  }
});

socket.on("disconnect", () => {
  $("#connection-dot").classList.remove("online");
  $("#connection-text").textContent = "连接已断开，正在重试";
  if (state) showToast("与服务器断开，正在自动重连");
});

socket.on("session", (session) => {
  const name = nameInput.value.trim() || getSession()?.name || "玩家";
  setSession({ ...session, name });
  history.replaceState(null, "", `?room=${session.code}`);
});

socket.on("board-meta", (meta) => {
  boardMeta = meta;
  if (state) renderBoard();
});

socket.on("room-state", (nextState) => {
  awaitingRoom = false;
  state = nextState;
  if (selected && !state.pieces.some((piece) => piece.position === selected)) selected = null;
  entryScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  render();
});

socket.on("game-error", (message) => {
  if (awaitingRoom) {
    awaitingRoom = false;
    clearSession();
  }
  showToast(message);
});

socket.on("session-replaced", () => showToast("此座位已在另一个页面连接"));

function transformPoint(point) {
  const seat = state?.viewerSeat || "south";
  if (seat === "north") return { x: 16 - point.x, y: 16 - point.y };
  if (seat === "east") return { x: 16 - point.y, y: point.x };
  if (seat === "west") return { x: point.y, y: 16 - point.x };
  return { x: point.x, y: point.y };
}

function svgElement(tag, attrs = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function drawLine(layer, a, b, className) {
  const from = transformPoint(a);
  const to = transformPoint(b);
  layer.append(svgElement("line", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: className }));
}

function renderBoard() {
  if (!boardMeta || !state) return;
  boardSvg.replaceChildren();
  const nodeMap = new Map(boardMeta.nodes.map((node) => [node.id, node]));

  const roadLayer = svgElement("g");
  const railBaseLayer = svgElement("g");
  const railLayer = svgElement("g");
  const nodeLayer = svgElement("g");
  const pieceLayer = svgElement("g");

  for (const [aId, bId] of boardMeta.roads) drawLine(roadLayer, nodeMap.get(aId), nodeMap.get(bId), "road");
  for (const [aId, bId] of boardMeta.rails) {
    drawLine(railBaseLayer, nodeMap.get(aId), nodeMap.get(bId), "rail-base");
    drawLine(railLayer, nodeMap.get(aId), nodeMap.get(bId), "rail");
  }
  boardSvg.append(roadLayer, railBaseLayer, railLayer);

  const labelPoints = {
    north: { x: 8, y: 2.5 }, east: { x: 13.5, y: 8 }, south: { x: 8, y: 13.5 }, west: { x: 2.5, y: 8 },
  };
  for (const seat of state.activeSeats) {
    const point = transformPoint(labelPoints[seat]);
    const text = svgElement("text", { x: point.x, y: point.y, class: "sector-label" });
    text.textContent = boardMeta.seatNames[seat];
    roadLayer.append(text);
  }

  for (const node of boardMeta.nodes) {
    const point = transformPoint(node);
    const group = svgElement("g", { class: "node clickable", "data-node": node.id, tabindex: "0", role: "button" });
    if (node.kind === "camp") {
      const rect = svgElement("rect", { x: point.x - 0.23, y: point.y - 0.23, width: 0.46, height: 0.46, transform: `rotate(45 ${point.x} ${point.y})`, class: "node-camp" });
      group.append(rect);
      const mark = svgElement("text", { x: point.x, y: point.y + 0.01, class: "node-mark" });
      mark.textContent = "营";
      group.append(mark);
    } else if (node.kind === "hq") {
      group.append(svgElement("rect", { x: point.x - 0.29, y: point.y - 0.22, width: 0.58, height: 0.44, rx: 0.06, class: "node-hq" }));
      const mark = svgElement("text", { x: point.x, y: point.y + 0.01, class: "node-mark" });
      mark.textContent = "本营";
      group.append(mark);
    } else {
      group.append(svgElement("circle", { cx: point.x, cy: point.y, r: 0.14, class: "node-station" }));
    }
    group.addEventListener("click", () => handleBoardClick(node.id));
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") handleBoardClick(node.id);
    });
    nodeLayer.append(group);
  }

  for (const piece of state.pieces) {
    const node = nodeMap.get(piece.position);
    if (!node) continue;
    const point = transformPoint(node);
    const color = seatColor(piece.owner);
    const group = svgElement("g", {
      class: `piece ${piece.type ? "" : "owner-hidden"} ${piece.position === selected ? "selected" : ""} ${piece.revealed ? "revealed" : ""}`,
      "data-piece": piece.id,
      tabindex: "0",
      role: "button",
      "aria-label": piece.type ? `${boardMeta.seatNames[piece.owner]}${boardMeta.pieceNames[piece.type]}` : `${boardMeta.seatNames[piece.owner]}暗棋`,
    });
    group.append(svgElement("rect", { x: point.x - 0.41, y: point.y - 0.31, width: 0.82, height: 0.62, class: "piece-border" }));
    group.append(svgElement("rect", { x: point.x - 0.39, y: point.y - 0.29, width: 0.78, height: 0.58, fill: color, class: "piece-body" }));
    if (piece.type) {
      const label = svgElement("text", { x: point.x, y: point.y + 0.018, class: "piece-label" });
      label.textContent = boardMeta.pieceNames[piece.type];
      group.append(label);
    }
    group.addEventListener("click", (event) => { event.stopPropagation(); handleBoardClick(piece.position); });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") handleBoardClick(piece.position);
    });
    pieceLayer.append(group);
  }
  boardSvg.append(nodeLayer, pieceLayer);
}

function handleBoardClick(position) {
  if (!state || state.phase === "finished") return;
  const piece = state.pieces.find((item) => item.position === position);
  if (state.phase === "setup") {
    const me = state.players.find((player) => player.seat === state.viewerSeat);
    if (me?.ready) return showToast("取消准备后才能调整布阵");
    if (!selected) {
      if (piece?.owner !== state.viewerSeat) return;
      selected = position;
    } else if (position === selected) {
      selected = null;
    } else if (piece?.owner === state.viewerSeat) {
      socket.emit("swap-setup", { from: selected, to: position });
      selected = null;
    }
    return renderBoard();
  }

  if (state.phase === "playing") {
    if (state.turn !== state.viewerSeat) return showToast("还没有轮到你");
    if (!selected) {
      if (piece?.owner !== state.viewerSeat) return;
      selected = position;
    } else if (position === selected) {
      selected = null;
    } else if (piece?.owner === state.viewerSeat) {
      selected = position;
    } else {
      socket.emit("move", { from: selected, to: position });
      selected = null;
    }
    renderBoard();
  }
}

function playerStatus(player) {
  if (player.empty) return "等待加入";
  if (player.eliminated) return "已退出对局";
  if (!player.online) return "等待重连";
  if (state.phase === "setup") return player.ready ? "已准备" : "正在布阵";
  if (state.phase === "finished") return "对局结束";
  return state.turn === player.seat ? "正在行动" : "等待行动";
}

function renderPlayers() {
  const list = $("#players-list");
  list.replaceChildren();
  for (const player of state.players) {
    const card = document.createElement("article");
    card.className = `player-card ${state.turn === player.seat ? "active-turn" : ""} ${player.eliminated ? "eliminated" : ""}`;
    card.style.setProperty("--seat-color", seatColor(player.seat) || "#aaa");
    const me = player.seat === state.viewerSeat ? " · 你" : "";
    const host = player.isHost ? " · 房主" : "";
    card.innerHTML = `
      <div class="seat-badge">${seatShort[player.seat]}</div>
      <div class="player-info">
        <div class="player-name">${player.empty ? "空座" : escapeHtml(player.name)}${me}</div>
        <div class="player-status">${boardMeta?.seatNames[player.seat] || player.seat}${host}</div>
      </div>
      <div class="player-state">${playerStatus(player)}</div>`;
    list.append(card);
  }
}

function addControl(label, className, action, disabled = false) {
  const button = document.createElement("button");
  button.className = `control-button ${className || ""}`;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

function renderControls() {
  const hostControls = $("#host-controls");
  const boardControls = $("#board-controls");
  hostControls.replaceChildren();
  boardControls.replaceChildren();
  const me = state.players.find((player) => player.seat === state.viewerSeat);

  if (state.phase === "setup") {
    boardControls.append(
      addControl("随机布阵", "alt", () => { selected = null; socket.emit("randomize-setup"); }, me?.ready),
      addControl(me?.ready ? "取消准备" : "完成布阵", "", () => { selected = null; socket.emit("toggle-ready"); }),
    );
    const hint = document.createElement("span");
    hint.className = "setup-hint";
    hint.textContent = me?.ready ? "等待其他玩家与房主开始" : "点击两枚棋子交换位置";
    boardControls.append(hint);

    if (state.viewerSeat === state.hostSeat) {
      const full = state.players.every((player) => !player.empty);
      const allReady = full && state.players.every((player) => player.ready);
      hostControls.append(addControl("开始对局", "", () => socket.emit("start-game"), !allReady));
      if (!allReady) {
        const hintText = document.createElement("div");
        hintText.className = "setup-hint";
        hintText.textContent = full ? "所有玩家准备后即可开始" : `等待 ${state.capacity - state.players.filter((p) => !p.empty).length} 名玩家加入`;
        hostControls.append(hintText);
      }
    }
  } else if (state.phase === "playing" && !me?.eliminated) {
    boardControls.append(addControl("认输", "danger", () => {
      if (confirm("确认认输并退出本局吗？")) socket.emit("resign");
    }));
  } else if (state.phase === "finished") {
    const result = document.createElement("strong");
    result.textContent = `${state.winner}获胜`;
    boardControls.append(result);
  }
}

function renderLogs() {
  const log = $("#battle-log");
  log.replaceChildren();
  if (!state.logs.length) {
    const empty = document.createElement("div");
    empty.className = "empty-log";
    empty.textContent = "还没有战况";
    log.append(empty);
    return;
  }
  for (const item of state.logs) {
    const element = document.createElement("div");
    element.className = `log-item ${item.tone || ""}`;
    element.textContent = item.text;
    log.append(element);
  }
}

function render() {
  if (!state) return;
  $("#room-code-label").textContent = state.code;
  $("#mode-label").textContent = state.mode === "alliance" ? "对家结盟" : "各自为战";
  const phases = { setup: "布阵中", playing: "对局进行中", finished: "对局结束" };
  $("#phase-label").textContent = phases[state.phase];
  if (state.phase === "playing") {
    const turnName = boardMeta?.seatNames[state.turn] || state.turn;
    $("#turn-banner").textContent = state.turn === state.viewerSeat ? "轮到你行动" : `等待${turnName}行动`;
  } else if (state.phase === "finished") {
    $("#turn-banner").textContent = `${state.winner}获胜`;
  } else {
    $("#turn-banner").textContent = "完成布阵并准备，等待房主开局";
  }
  renderPlayers();
  renderBoard();
  renderControls();
  renderLogs();
}

$("#room-code-button").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("邀请链接已复制", "success");
  } catch {
    showToast(`房间码：${state.code}`, "success");
  }
});

$("#leave-button").addEventListener("click", () => {
  if (!confirm("确认离开当前房间吗？")) return;
  socket.emit("leave-room");
  clearSession();
  history.replaceState(null, "", location.pathname);
  state = null;
  selected = null;
  gameScreen.classList.add("hidden");
  entryScreen.classList.remove("hidden");
});

const rulesDialog = $("#rules-dialog");
$("#stealth-button").addEventListener("click", () => {
  stealthMode = !stealthMode;
  localStorage.setItem("junqi-stealth", stealthMode ? "1" : "0");
  applyStealthMode();
  if (state) {
    renderPlayers();
    renderBoard();
  }
});
$("#rules-button").addEventListener("click", () => rulesDialog.showModal());
$("#close-rules").addEventListener("click", () => rulesDialog.close());
rulesDialog.addEventListener("click", (event) => {
  if (event.target === rulesDialog) rulesDialog.close();
});
