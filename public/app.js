const socket = io({ transports: ["websocket", "polling"] });

const $ = (selector) => document.querySelector(selector);
const entryScreen = $("#entry-screen");
const gameScreen = $("#game-screen");
const nameInput = $("#player-name");
const passwordInput = $("#player-password");
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
let auth = null;
let pieceMarks = {};
let markTarget = null;
let roomList = [];

try { auth = JSON.parse(localStorage.getItem("junqi-auth")); } catch { auth = null; }
if (auth?.username) nameInput.value = auth.username;
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

function showAuthenticated() {
  if (!auth?.token) return;
  document.querySelectorAll("[data-logout]").forEach(button => button.classList.remove("hidden"));
  $("#login-title").textContent = `已登录：${auth.username}`;
  $("#login-form").classList.add("logged-in");
  $("#entry-actions").classList.remove("hidden");
}

showAuthenticated();

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: nameInput.value.trim(), password: passwordInput.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    auth = result;
    localStorage.setItem("junqi-auth", JSON.stringify(auth));
    passwordInput.value = "";
    showAuthenticated();
    showToast("登录成功", "success");
  } catch (error) { showToast(error.message || "登录失败"); }
});

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
    authToken: auth?.token,
    capacity: Number(capacityInput.value),
    mode: modeInput.value,
  });
});

$("#join-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 6) return showToast("请输入六位房间码");
  awaitingRoom = true;
  socket.emit("join-room", { authToken: auth?.token, code });
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
    socket.emit("join-room", { ...session, authToken: auth?.token });
  }
});

socket.on("disconnect", () => {
  $("#connection-dot").classList.remove("online");
  $("#connection-text").textContent = "连接已断开，正在重试";
  if (state) showToast("与服务器断开，正在自动重连");
});

socket.on("session", (session) => {
  setSession(session);
  history.replaceState(null, "", `?room=${session.code}`);
});

socket.on("board-meta", (meta) => {
  boardMeta = meta;
  if (state) renderBoard();
});

socket.on("room-state", (nextState) => {
  awaitingRoom = false;
  state = nextState;
  try { pieceMarks = JSON.parse(localStorage.getItem(`junqi-marks-${state.code}`) || "{}"); } catch { pieceMarks = {}; }
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
function exitClosedRoom(message) {
  clearSession(); state = null; selected = null; closeMarkMenu();
  gameScreen.classList.add("hidden"); entryScreen.classList.remove("hidden");
  history.replaceState(null, "", location.pathname); showToast(message);
}
socket.on("kicked", () => exitClosedRoom("你已被房主踢出房间"));
socket.on("room-closed", () => exitClosedRoom("房主已关闭房间"));

socket.on("room-list", (rooms) => {
  roomList = rooms;
  renderRoomList();
});

function renderRoomList() {
  const list = $("#room-list");
  if (!list) return;
  list.replaceChildren();
  if (!roomList.length) {
    const empty = document.createElement("div");
    empty.className = "empty-log";
    empty.textContent = "暂无房间";
    list.append(empty);
    return;
  }
  for (const room of roomList) {
    const row = document.createElement("article");
    row.className = "room-row";
    const phase = { setup: "布阵中", playing: "对局中", finished: "已结束" }[room.phase];
    row.innerHTML = `<div><strong>${room.code}</strong><span>${room.players}/${room.capacity} 人 · ${phase} · ${room.spectators} 人在场</span></div><button type="button">进入</button>`;
    row.querySelector("button").addEventListener("click", () => {
      awaitingRoom = true;
      socket.emit("watch-room", { code: room.code, authToken: auth?.token });
    });
    list.append(row);
  }
}

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
  const moveLayer = svgElement("g");
  const nodeLayer = svgElement("g");
  const pieceLayer = svgElement("g");

  for (const [aId, bId] of boardMeta.roads) drawLine(roadLayer, nodeMap.get(aId), nodeMap.get(bId), "road");
  for (const [aId, bId] of boardMeta.rails) {
    drawLine(railBaseLayer, nodeMap.get(aId), nodeMap.get(bId), "rail-base");
    drawLine(railLayer, nodeMap.get(aId), nodeMap.get(bId), "rail");
  }
  boardSvg.append(roadLayer, railBaseLayer, railLayer);

  if (state.lastMove) {
    const fromNode = nodeMap.get(state.lastMove.from);
    const toNode = nodeMap.get(state.lastMove.to);
    if (fromNode && toNode) {
      const from = transformPoint(fromNode);
      const to = transformPoint(toNode);
      moveLayer.append(svgElement("line", {
        x1: from.x,
        y1: from.y,
        x2: to.x,
        y2: to.y,
        class: "last-move-path",
      }));
      moveLayer.append(svgElement("circle", { cx: from.x, cy: from.y, r: 0.22, class: "last-move-endpoint" }));
      moveLayer.append(svgElement("circle", { cx: to.x, cy: to.y, r: 0.26, class: "last-move-endpoint last-move-target" }));
    }
  }

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
    const lastMoved = state.lastMove?.pieceId === piece.id;
    const group = svgElement("g", {
      class: `piece ${piece.type ? "" : "owner-hidden"} ${piece.position === selected ? "selected" : ""} ${piece.revealed ? "revealed" : ""} ${lastMoved ? "last-moved" : ""}`,
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
    if (piece.owner !== state.viewerSeat && pieceMarks[piece.id]) {
      const guess = svgElement("text", { x: point.x, y: point.y + 0.018, class: "piece-guess" });
      guess.textContent = pieceMarks[piece.id];
      group.append(guess);
    }
    group.addEventListener("contextmenu", (event) => {
      if (piece.owner === state.viewerSeat) return;
      event.preventDefault(); event.stopPropagation(); openMarkMenu(piece, event);
    });
    if (lastMoved) {
      group.append(svgElement("rect", {
        x: point.x - 0.48,
        y: point.y - 0.38,
        width: 0.96,
        height: 0.76,
        rx: 0.14,
        class: "last-moved-outline",
      }));
    }
    group.addEventListener("click", (event) => { event.stopPropagation(); handleBoardClick(piece.position); });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") handleBoardClick(piece.position);
    });
    pieceLayer.append(group);
  }
  boardSvg.append(moveLayer, nodeLayer, pieceLayer);
}

function openMarkMenu(piece, event) {
  markTarget = piece.id;
  const menu = $("#piece-mark-menu");
  menu.replaceChildren();
  for (const name of Object.values(boardMeta.pieceNames)) {
    const button = document.createElement("button");
    button.type = "button"; button.role = "menuitem"; button.textContent = name;
    if (pieceMarks[piece.id] === name) button.classList.add("selected");
    button.addEventListener("click", () => {
      pieceMarks[piece.id] = name; saveMarks(); closeMarkMenu(); renderBoard();
    });
    menu.append(button);
  }
  const clear = document.createElement("button");
  clear.type = "button"; clear.role = "menuitem"; clear.className = "clear-mark"; clear.textContent = "清除标记";
  clear.addEventListener("click", () => {
    delete pieceMarks[piece.id]; saveMarks(); closeMarkMenu(); renderBoard();
  });
  menu.append(clear);
  menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - 238))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - 188))}px`;
  menu.classList.remove("hidden");
}
function closeMarkMenu() { $("#piece-mark-menu").classList.add("hidden"); markTarget = null; }
function saveMarks() { localStorage.setItem(`junqi-marks-${state.code}`, JSON.stringify(pieceMarks)); }

function handleBoardClick(position) {
  if (!state || state.spectator || state.phase === "finished") return;
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
  if (player.empty) return state.phase === "playing" ? "等待接替" : "等待落座";
  if (player.eliminated) return "已退出对局";
  if (!player.online) return "等待重连";
  if (state.phase === "setup") return player.ready ? "已准备" : "正在布阵";
  if (state.phase === "finished") return "对局结束";
  return state.turn === player.seat ? "正在行动" : "等待行动";
}

function kickButton(name) {
  const button = document.createElement("button");
  button.className = "kick-button"; button.type = "button"; button.textContent = "踢出";
  button.addEventListener("click", () => { if (confirm(`确定踢出 ${name} 吗？`)) socket.emit("kick-member", { name }); });
  return button;
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
    card.innerHTML = `<div class="seat-badge">${seatShort[player.seat]}</div><div class="player-info"><div class="player-name">${player.empty ? "空座" : escapeHtml(player.name)}${me}</div><div class="player-status">${boardMeta?.seatNames[player.seat] || player.seat}${host}</div></div><div class="player-state">${playerStatus(player)}</div>`;
    if (state.isHost && !player.empty && !player.isHost) card.append(kickButton(player.name));
    list.append(card);
  }
  const watchers = $("#spectators-list"); watchers.replaceChildren();
  if (state.spectators?.length) {
    const title = document.createElement("strong"); title.textContent = "离座 / 观战"; watchers.append(title);
    for (const member of state.spectators) {
      const row = document.createElement("div"); row.className = "spectator-row";
      const label = document.createElement("span"); label.textContent = member.name + (member.isHost ? " · 房主" : member.name === state.viewerName ? " · 你" : ""); row.append(label);
      if (state.isHost && !member.isHost) row.append(kickButton(member.name));
      watchers.append(row);
    }
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
  const hostControls = $("#host-controls"), boardControls = $("#board-controls");
  hostControls.replaceChildren(); boardControls.replaceChildren();
  const me = state.players.find((player) => player.seat === state.viewerSeat);
  if (state.isHost) {
    if (state.phase === "setup") {
      const full = state.players.every((player) => !player.empty);
      const allReady = full && state.players.every((player) => player.ready);
      hostControls.append(addControl("开始对局", "", () => socket.emit("start-game"), !allReady));
    }
    hostControls.append(addControl("关闭房间", "danger", () => { if (confirm("确定关闭房间并让所有人退出吗？")) socket.emit("close-room"); }));
  }
  if (state.phase === "setup") {
    if (state.spectator) {
      const label = document.createElement("strong"); label.textContent = "选择空方向落座："; boardControls.append(label);
      for (const player of state.players.filter(item => item.empty)) boardControls.append(addControl(boardMeta.seatNames[player.seat], "alt", () => socket.emit("take-seat", { seat: player.seat })));
      const hint = document.createElement("span"); hint.className = "setup-hint"; hint.textContent = "当前为离座状态，等价于观战"; boardControls.append(hint);
    } else {
      boardControls.append(addControl("随机布阵", "alt", () => { selected = null; socket.emit("randomize-setup"); }, me?.ready), addControl(me?.ready ? "取消准备" : "完成布阵", "", () => { selected = null; socket.emit("toggle-ready"); }), addControl("离座观战", "alt", () => { selected = null; socket.emit("leave-seat"); }));
      const hint = document.createElement("span"); hint.className = "setup-hint"; hint.textContent = me?.ready ? "等待其他玩家与房主开始" : "点击两枚棋子交换位置"; boardControls.append(hint);
    }
  } else if (state.spectator && state.phase === "playing") {
    const badge = document.createElement("strong"); badge.textContent = "观战模式 · 可接替空缺方向："; boardControls.append(badge);
    for (const player of state.players.filter(item => item.empty)) boardControls.append(addControl(boardMeta.seatNames[player.seat], "alt", () => socket.emit("take-seat", { seat: player.seat })));
  } else if (state.spectator) {
    const badge = document.createElement("strong"); badge.textContent = "观战模式 · 棋子名称已隐藏"; boardControls.append(badge);
  } else if (state.phase === "playing" && !me?.eliminated) {
    boardControls.append(addControl("离座观战", "alt", () => { if (confirm("离座后棋子会原位保留，其他人可以接替。确定离座吗？")) socket.emit("leave-seat"); }), addControl("认输", "danger", () => { if (confirm("确认认输并退出本局吗？")) socket.emit("resign"); }));
  } else if (state.phase === "finished") {
    const result = document.createElement("strong"); result.textContent = `${state.winner}获胜`; boardControls.append(result);
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
    element.className = `log-item ${item.tone || ""} ${item.private ? "private" : ""}`;
    element.textContent = item.text;
    log.append(element);
  }
}

function renderChat() {
  const list = $("#chat-list");
  list.replaceChildren();
  for (const item of state.chat || []) {
    const row = document.createElement("div");
    row.className = "chat-item";
    row.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.text)}</span>`;
    list.append(row);
  }
  list.scrollTop = list.scrollHeight;
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
  if (state.spectator) $("#turn-banner").textContent = `正在观战 · ${$("#turn-banner").textContent}`;
  renderPlayers();
  renderBoard();
  renderControls();
  renderLogs();
  renderChat();
}

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat-message", { text });
  input.value = "";
});

$("#room-code-button").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(url);
    showToast("邀请链接已复制", "success");
  } catch {
    showToast(`房间码：${state.code}`, "success");
  }
});

document.addEventListener("click", event => { if (!event.target.closest("#piece-mark-menu")) closeMarkMenu(); });

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

$("#stealth-button").addEventListener("click", () => {
  stealthMode = !stealthMode;
  localStorage.setItem("junqi-stealth", stealthMode ? "1" : "0");
  applyStealthMode();
  window.dispatchEvent(new Event("junqi-theme-refresh"));
  if (state) {
    renderPlayers();
    renderBoard();
  }
});

socket.on("account-deleted", () => {
  localStorage.removeItem("junqi-auth");
  localStorage.removeItem("junqi-session");
  window.location.reload();
});

window.addEventListener("junqi-theme", () => { stealthMode = localStorage.getItem("junqi-stealth") === "1"; applyStealthMode(); if (state) { renderPlayers(); renderBoard(); } });

document.querySelectorAll("[data-logout]").forEach(button => {
  button.addEventListener("click", async () => {
    document.querySelectorAll("[data-logout]").forEach(item => item.disabled = true);
    try {
      const response = await fetch("/api/logout", { method: "POST", headers: { Authorization: "Bearer " + (auth?.token || "") } });
      if (!response.ok) throw new Error("退出失败，请重试");
      socket.disconnect();
      localStorage.removeItem("junqi-auth");
      localStorage.removeItem("junqi-session");
      auth = null;
      window.location.assign("/");
    } catch (error) {
      showToast(error.message || "退出失败，请重试");
      document.querySelectorAll("[data-logout]").forEach(item => item.disabled = false);
    }
  });
});
