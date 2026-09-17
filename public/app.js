import {renderRichChatBody,attachChatFold,releaseChatFolds} from './chat-common.js';
import {copySourceButton,renderMutedUsers} from './chat-controls.js';
import {emojiGroups,emojis} from './emojis.js';
import {colorRating} from './rating-colors.js';
import {avatarImage,messageTime} from './avatars.js';
import { attachImages, composeImages, clearImages, displayImage } from './chat-images.js';
import { secureSocket, bytes, b64 } from './secure.js';
const socket = secureSocket();

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
const seatColors = { north: "#808080", east: "#800000", south: "#008000", west: "#000080" };
let boardMeta = null;
let state = null;
let selected = null;
let awaitingRoom = false;
let toastTimer = null;
let auth = null;
let mentionNotifications = localStorage.getItem('junqi-mention-notifications') === '1';
const mentionButton = $('#mention-notifications');
function renderMentionSetting() {
  mentionButton.textContent = `@ 提醒：${mentionNotifications ? '开' : '关'}`;
  mentionButton.setAttribute('aria-pressed', String(mentionNotifications));
}
renderMentionSetting();
mentionButton.onclick = async () => {
  if (!mentionNotifications) {
    if (!window.isSecureContext || !('Notification' in window)) {
      showToast('浏览器通知需要 HTTPS 或 localhost，并需要浏览器支持'); return;
    }
    try {
      if (await Notification.requestPermission() !== 'granted') {
        showToast('请在浏览器网站权限中允许通知'); return;
      }
    } catch { showToast('无法申请通知权限'); return; }
  }
  mentionNotifications = !mentionNotifications;
  localStorage.setItem('junqi-mention-notifications', mentionNotifications ? '1' : '0');
  renderMentionSetting();
};
const seenMentions = new Set();
socket.on('chat-mention', message => {
  if ((message.code !== 'lobby' && (!state || state.code !== message.code)) || seenMentions.has(message.id)) return;
  seenMentions.add(message.id);
  if (seenMentions.size > 100) seenMentions.delete(seenMentions.values().next().value);
  showToast(`${message.name} 在聊天中提到了你`);
  if (!mentionNotifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notification = new Notification('四国军棋：有人 @ 你', {
      body: `${message.name}：${message.text}`, tag: `junqi-mention-${message.code}`
    });
    notification.onclick = () => {
      window.focus(); $(message.code === 'lobby' ? '#lobby-chat-input' : '#chat-input').focus(); notification.close();
    };
  } catch { showToast('浏览器未能显示通知，请检查系统通知设置'); }
});
let turnNotifications = localStorage.getItem('junqi-turn-notifications') === '1';
let activeTurnNotification = null;
function updateNotificationButton() {
  const button = $('#turn-notifications');
  button.textContent = `走棋通知：${turnNotifications ? '开' : '关'}`;
  button.setAttribute('aria-pressed', String(turnNotifications));
}
function updateTurnNotification(next) {
  const player = next.players.find(p => p.seat === next.viewerSeat);
  const myTurn = next.phase === 'playing' && !next.spectator && player &&
    !player.eliminated && !player.isBot && next.turn === next.viewerSeat;
  if (!myTurn || !turnNotifications) {
    activeTurnNotification?.close(); activeTurnNotification = null;
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const key = JSON.stringify([next.code, next.viewerName, next.viewerSeat, next.ply]);
  if (sessionStorage.getItem('junqi-last-notified-turn') === key) return;
  try {
    activeTurnNotification?.close();
    const notification = new Notification('四国军棋：轮到你走棋了', {
      body: `${next.viewerName}，房间 ${next.code} 等待你行动。`,
      tag: 'junqi-my-turn'
    });
    activeTurnNotification = notification;
    sessionStorage.setItem('junqi-last-notified-turn', key);
    notification.onclick = () => { window.focus(); notification.close(); };
  } catch { showToast('浏览器未能显示通知，请检查系统通知设置'); }
}
updateNotificationButton();
$('#turn-notifications').onclick = async () => {
  if (turnNotifications) {
    turnNotifications = false;
    activeTurnNotification?.close(); activeTurnNotification = null;
  } else {
    if (!window.isSecureContext || !('Notification' in window)) {
      showToast('浏览器通知需要 HTTPS 或 localhost，并需要浏览器支持'); return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        showToast('通知未获允许，可在浏览器的网站权限中修改'); return;
      }
      turnNotifications = true;
    } catch { showToast('无法申请浏览器通知权限'); return; }
  }
  localStorage.setItem('junqi-turn-notifications', turnNotifications ? '1' : '0');
  updateNotificationButton();
  if (state) updateTurnNotification(state);
};
socket.on('disconnect', () => { activeTurnNotification?.close(); activeTurnNotification = null; });
let pieceMarks = {};
let markTarget = null;
let roomList = [];
let lobbyChatState = [];
let lobbyMuted = [];
let bannedUsers = [];
socket.on('account-profile',profile=>{
  if(!auth)return;
  auth={...auth,...profile};localStorage.setItem('junqi-auth',JSON.stringify(auth));
  window.dispatchEvent(new Event('junqi-profile-refresh'));
  $('#announcement-form').hidden = !auth.admin;
  renderRoomList();renderChat(lobbyChatState,$('#lobby-chat-list'));
});
socket.on('moderation-state', (moderation) => {
  lobbyMuted = moderation?.muted || [];
  bannedUsers = moderation?.banned || [];
  renderChat(state?.chat || [], $('#chat-list'));
  renderChat(lobbyChatState, $('#lobby-chat-list'));
});

try { auth = JSON.parse(localStorage.getItem("junqi-auth")); } catch { auth = null; }
if (auth?.username) nameInput.value = auth.username;
const invitedCode = /^\/room\/([A-Za-z0-9]{6})\/?$/.exec(location.pathname)?.[1];
if (invitedCode) codeInput.value = invitedCode.toUpperCase().slice(0, 6);

function getSession() {
  try { return JSON.parse(sessionStorage.getItem("junqi-session")); }
  catch { return null; }
}

function setSession(session) {
  sessionStorage.setItem("junqi-session", JSON.stringify(session));
}

function clearSession() {
  sessionStorage.removeItem("junqi-session");
}
function joinAddressRoom() {
  const code = /^\/room\/([A-Za-z0-9]{6})\/?$/.exec(location.pathname)?.[1];
  if (!code || !auth?.token || !socket.connected) return;
  const saved = getSession();
  awaitingRoom = true;
  socket.emit('join-room', { code: code.toUpperCase(), authToken: auth.token, token: saved?.code === code.toUpperCase() ? saved.token : undefined });
}

function showToast(message, kind = "error") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast show ${kind === "success" ? "success" : ""}`;
  toastTimer = setTimeout(() => { toast.className = "toast"; }, 2800);
}

function seatColor(seat) {
  return seatColors[seat] || boardMeta?.seatColors[seat];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function showAuthenticated() {
  if (!auth?.token) return;
  socket.emit('lobby-auth', { authToken: auth.token });
  document.querySelectorAll("[data-logout]").forEach(button => button.classList.remove("hidden"));
  const ratingText = auth.rating == null ? "" : ` · ${auth.rank} ${auth.rating}`;
  $("#login-title").replaceChildren('已登录：');
  const profile = colorRating(document.createElement('span'), auth.rating);
  profile.textContent = auth.username; $('#login-title').append(profile);
  if(auth.rating != null) {
    $('#login-title').append(' · ');
    const badge = colorRating(document.createElement('span'), auth.rating); badge.textContent = `${auth.rank} ${auth.rating}`; $('#login-title').append(badge);
  }
  window.dispatchEvent(new Event('junqi-profile-refresh'));
  $("#login-form").classList.add("logged-in");
  $("#entry-actions").classList.remove("hidden");
  $('#create-form').hidden = auth.accountType === 'bot';
  renderRoomList();
}

showAuthenticated();
if (auth?.token) {
  fetch("/api/me", { headers: { Authorization: `Bearer ${auth.token}` } }).then(async (response) => {
    if (!response.ok) {
      auth = null; localStorage.removeItem("junqi-auth"); clearSession();
      document.querySelectorAll("[data-logout]").forEach(button => button.classList.add("hidden"));
      $("#login-title").textContent = "登录";
      $("#login-form").classList.remove("logged-in");
      $("#entry-actions").classList.add("hidden");
      window.dispatchEvent(new Event('junqi-profile-refresh'));
      return;
    }
    auth = await response.json();
    localStorage.setItem("junqi-auth", JSON.stringify(auth));
    showAuthenticated();
    joinAddressRoom();
  }).catch(() => {});
}

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
    joinAddressRoom();
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
    name: $("#new-room-name").value,
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
  if (auth?.token) socket.emit('lobby-auth', { authToken: auth.token });
  $("#connection-dot").classList.add("online");
  $("#connection-text").textContent = "服务器已连接";
  joinAddressRoom();
});

socket.on("disconnect", () => {
  $("#connection-dot").classList.remove("online");
  $("#connection-text").textContent = "连接已断开，正在重试";
  if (state) showToast("与服务器断开，正在自动重连");
});

socket.on("session", (session) => {
  setSession(session);
  history.replaceState(null, "", `/room/${session.code}`);
});

socket.on("board-meta", (meta) => {
  boardMeta = meta;
  if (state) renderBoard();
});

socket.on("room-state", (nextState) => {
  updateTurnNotification(nextState);
  awaitingRoom = false;
  state = nextState;
  const viewerProfile = state.players.find((player) => player.seat === state.viewerSeat)
    || state.spectators.find((member) => member.name === state.viewerName);
  if (auth && viewerProfile?.rating != null) {
    auth = { ...auth, rating: viewerProfile.rating, ratedGames: viewerProfile.ratedGames, peakRating: viewerProfile.peakRating, rank: viewerProfile.rank, rankClass: viewerProfile.rankClass };
    localStorage.setItem("junqi-auth", JSON.stringify(auth));
  }
  try { pieceMarks = JSON.parse(localStorage.getItem(`junqi-marks-${state.code}`) || "{}"); } catch { pieceMarks = {}; }
  if (selected && !state.pieces.some((piece) => piece.position === selected)) selected = null;
  entryScreen.classList.add("hidden");
  gameScreen.classList.remove("hidden");
  window.dispatchEvent(new Event('junqi-page-change'));
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
  $('#chat-list').closest('.chat-panel').classList.remove('chat-expanded');
  history.replaceState(null, "", '/'); showToast(message);
  window.dispatchEvent(new Event('junqi-page-change'));
}
socket.on("kicked", () => exitClosedRoom("你已被房主踢出房间"));
socket.on("room-closed", () => exitClosedRoom("房主已关闭房间"));

socket.on("room-list", (rooms) => {
  roomList = [...new Map(rooms.map(room=>[room.code,room])).values()];
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
    let group=list.querySelector(`[data-phase="${room.phase}"]`);
    if(!group){group=document.createElement('section');group.dataset.phase=room.phase;const h=document.createElement('h3');h.textContent={setup:'即将开始',playing:'正在进行',finished:'已经结束'}[room.phase];group.append(h);list.append(group);}
    const row = document.createElement("article");
    row.className = "room-row";
    const phase = { setup: "布阵中", playing: "对局中", finished: "已结束" }[room.phase];
    const info=document.createElement('div'),title=document.createElement('strong'),code=document.createElement('small'),details=document.createElement('span'),enter=document.createElement('button');
    title.textContent=room.name||room.code;code.textContent=room.code;
    details.textContent=`${room.phase==='setup'?'自动计分':room.rated ? (room.ratingPool==='bot'?'BOT Rated':'Rated') : '不计分'} · ${room.players}/${room.capacity} 人${room.bots ? `（${room.bots} BOT）` : ''} · ${phase}`;
    info.append(title,code,details);enter.type='button';enter.textContent=room.phase==='finished'?'查看 / 复盘':'进入';row.append(info,enter);
    enter.addEventListener("click", () => {
      if(!auth?.token){location.href='/login.html?next='+encodeURIComponent('/room/'+room.code);return;}
      awaitingRoom = true;
      socket.emit("watch-room", { code: room.code, authToken: auth?.token });
    });
    if (auth?.admin){const dissolve=document.createElement('button');dissolve.type='button';dissolve.className='danger-text';dissolve.textContent='解散';row.append(dissolve);dissolve.addEventListener("click", () => {
      if (!confirm(`解散 ${room.code}？房间及其棋局、聊天将永久删除。`)) return;
      socket.emit("admin-close-room", { code: room.code, authToken: auth?.token });
    });}
    if(auth?.admin && room.phase!=='finished'){const finish=document.createElement('button');finish.textContent='结束比赛';finish.onclick=()=>{if(confirm('结束比赛并保留记录？本局不计分。'))socket.emit('admin-finish-room',{code:room.code});};row.append(finish);}
    group.append(row);
  }
  for(const phase of ['setup','playing','finished']){let group=list.querySelector(`[data-phase="${phase}"]`);if(!group){group=document.createElement('section');group.dataset.phase=phase;const h=document.createElement('h3');h.textContent={setup:'即将开始',playing:'正在进行',finished:'已经结束'}[phase];group.append(h,document.createTextNode('暂无比赛'));}list.append(group);}
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

  const defs=svgElement('defs');
  const marker=svgElement('marker',{id:'move-arrow',viewBox:'0 0 10 10',refX:'8',refY:'5',markerWidth:'.7',markerHeight:'.7',orient:'auto-start-reverse'});
  marker.append(svgElement('path',{d:'M 0 0 L 10 5 L 0 10 z',class:'last-move-arrow'}));defs.append(marker);boardSvg.append(defs);
  const trails=state.moveTrails?.length?state.moveTrails:(state.lastMove?[state.lastMove]:[]);
  trails.forEach((move,index)=>{
    if(!nodeMap.has(move.from)||!nodeMap.has(move.to))return;
    const opacity=trails.length===1?1:.32+.68*index/(trails.length-1);
    moveLayer.append(svgElement('polyline',{
      points:(move.path||[move.from,move.to]).map(id=>nodeMap.get(id)).filter(Boolean).map(node=>{const p=transformPoint(node);return `${p.x},${p.y}`;}).join(' '),
      class:'last-move-path','marker-end':'url(#move-arrow)',opacity:opacity.toFixed(2),
    }));
  });

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
    group.append(svgElement("rect", { x: point.x - 0.56, y: point.y - 0.42, width: 1.12, height: 0.84, class: "piece-border" }));
    group.append(svgElement("rect", { x: point.x - 0.53, y: point.y - 0.39, width: 1.06, height: 0.78, fill: color, class: "piece-body" }));
    if (piece.type) {
      const label = svgElement("text", { x: point.x, y: point.y + 0.018, class: "piece-label" });
      label.textContent = boardMeta.pieceNames[piece.type];
      group.append(label);
    }
    if (piece.owner !== state.viewerSeat && pieceMarks[piece.id]) {
      const guess = svgElement("text", { x: point.x, y: point.y + 0.018, class: "piece-guess" });
      guess.textContent = pieceMarks[piece.id];
      if([...guess.textContent].reduce((n,c)=>n+(c.codePointAt(0)<128?1:2),0)>4){guess.setAttribute('textLength','0.76');guess.setAttribute('lengthAdjust','spacingAndGlyphs');}
      group.append(guess);
    }
    group.addEventListener("contextmenu", (event) => {
      if (piece.owner === state.viewerSeat) return;
      event.preventDefault(); event.stopPropagation(); openMarkMenu(piece, event);
    });
    if (lastMoved) {
      group.append(svgElement("rect", {
        x: point.x - 0.60,
        y: point.y - 0.46,
        width: 1.20,
        height: 0.92,
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
  const custom=document.createElement('button');custom.type='button';custom.role='menuitem';custom.textContent='自定义…';
  custom.onclick=()=>{const text=prompt('自定义标记：最多 6 个 ASCII 字符或 3 个汉字',pieceMarks[piece.id]||'');if(text===null)return;const value=text.trim();if(!value||[...value].reduce((n,c)=>n+(c.codePointAt(0)<128?1:2),0)>6||/[\u0000-\u001f\u007f]/.test(value)){showToast('标记宽度不能超过 6（汉字占 2），且不能为空');return;}pieceMarks[piece.id]=value;saveMarks();closeMarkMenu();renderBoard();};menu.append(custom);
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
  if (!player.online) return player.isBot ? "等待程序连接" : "等待重连";
  if (state.phase === "setup") return player.ready ? "已准备" : "正在布阵";
  if (state.phase === "finished") return "对局结束";
  return state.turn === player.seat ? "正在行动" : "等待行动";
}

function kickButton(target) {
  const name=target.name;
  const button = document.createElement("button");
  button.className = "kick-button"; button.type = "button"; button.textContent = "踢出";
  button.addEventListener("click", () => { if (confirm(`确定踢出 ${name} 吗？`)) socket.emit("kick-member", { name, seat:target.seat || null, memberId:target.memberId || null }); });
  return button;
}

function isRoomManagerNow() { return !!(state?.isHost || state?.viewerIsAdmin); }
function canModerateKick(target) {
  if (!state || !target || target.name === state.viewerName) return false;
  if (!isRoomManagerNow()) return false;
  if (target.admin) return false;
  if (target.isHost && !state.viewerIsAdmin) return false;
  return true;
}
function renderPlayers() {
  renderBotPanel();
  const list = $("#players-list");
  list.replaceChildren();
  for (const player of state.players) {
    const card = document.createElement("article");
    card.className = `player-card ${state.turn === player.seat ? "active-turn" : ""} ${player.eliminated ? "eliminated" : ""}`;
    card.style.setProperty("--seat-color", seatColor(player.seat) || "#aaa");
    const me = player.seat === state.viewerSeat ? " · 你" : "";
    const host = player.isHost ? " · 房主" : "";
    const rating = player.empty ? "" : `<span class="rank-badge cf-rated" data-cf="${player.rankClass}">${player.isBot?'BOT · ':''}${escapeHtml(player.rank)} · ${player.rating}</span>`;
    const change = state.ratingChanges?.[player.seat];
    const delta = change ? `<span class="rating-delta ${change.delta >= 0 ? "up" : "down"}">${change.delta >= 0 ? "+" : ""}${change.delta}</span>` : "";
    const signature=player.empty?'':(player.signature||'').replace(/[#*_`$<>\[\]]/g,'').replace(/\s+/g,' ').slice(0,48);
    card.innerHTML = `<div class="seat-badge">${seatShort[player.seat]}</div><div class="player-info"><div class="player-name">${player.empty ? "空座" : escapeHtml(player.name)}${me}</div><div class="player-status">${boardMeta?.seatNames[player.seat] || player.seat}${host}</div>${rating}${signature?`<div class="signature-snippet" title="${escapeHtml(player.signature||'')}">${escapeHtml(signature)}</div>`:''}</div><div class="player-state">${playerStatus(player)}${delta}</div>`;
    if(!player.empty){const old=card.querySelector('.player-name'),link=document.createElement('a');link.href='/profile/'+encodeURIComponent(player.name);link.textContent=player.name;colorRating(link,player.rating??1500);old.replaceChildren(link,document.createTextNode(me));}
    if (!player.empty) colorRating(card.querySelector('.player-name'), player.rating ?? 1500);
    if (canModerateKick(player) && !player.empty) card.append(kickButton(player));
    list.append(card);
  }
  const watchers = $("#spectators-list"); watchers.replaceChildren();
  if (state.spectators?.length) {
    const title = document.createElement("strong"); title.textContent = "离座 / 观战"; watchers.append(title);
    for (const member of state.spectators) {
      const row = document.createElement("div"); row.className = "spectator-row";
      const label = document.createElement("span"),link=document.createElement('a');link.href='/profile/'+encodeURIComponent(member.name);link.textContent=member.name;colorRating(link,member.rating);label.append(link,document.createTextNode(`${member.isHost ? " · 房主" : member.name === state.viewerName ? " · 你" : ""} · ${member.rank} ${member.rating}`));row.append(label);
      if (canModerateKick(member)) row.append(kickButton(member));
      watchers.append(row);
    }
  }
}

function renderBotPanel() {
  const panel = $('#bot-seat-panel');
  const oldSeat = panel.querySelector('[data-seat]')?.value;
  const oldBot = panel.querySelector('[data-bot]')?.value;
  panel.replaceChildren();
  panel.classList.toggle('hidden', !isRoomManagerNow() || state.phase === 'finished');
  if (!isRoomManagerNow() || state.phase === 'finished') return;
  const heading = document.createElement('h3'); heading.textContent = '添加 BOT 账号';
  const hint = document.createElement('p');
  panel.append(heading, hint);
  if (state.rated && state.phase==='playing') { hint.textContent = 'Rated 比赛开始后不能更换参赛账号。'; return; }
  const seats = state.players.filter(p => p.empty);
  hint.textContent = seats.length ? '选择空位和已审核的 BOT 账号。账号需在工作台启动程序。' : '当前没有空位。房主可先离座或踢出一人，再添加 BOT。';
  const seat = document.createElement('select'); seat.dataset.seat = ''; seat.setAttribute('aria-label', 'BOT 方向');
  seats.forEach(p => seat.add(new Option(boardMeta?.seatNames[p.seat] || p.seat, p.seat)));
  if (seats.some(p => p.seat === oldSeat)) seat.value = oldSeat;
  const bot = document.createElement('select'); bot.dataset.bot = ''; bot.setAttribute('aria-label', 'BOT 账号');
  const add = document.createElement('button'); add.textContent = '添加到所选位置';
  const populate = items => {
    const previous = bot.value || oldBot;
    bot.replaceChildren(new Option('请选择 BOT 账号', ''));
    items.forEach(item => { const option = new Option(`${item.username} · 已占 ${item.seats || 0} 位 · ${item.online ? '在线' : '离线'}`, item.username); colorRating(option, item.rating ?? 1500); bot.add(option); });
    if (items.some(i => i.username === previous)) bot.value = previous;
    add.disabled = !seat.value || !bot.value;
  };
  populate(state.botAccounts || []);
  bot.onchange = () => { add.disabled = !seat.value || !bot.value; };
  add.onclick = () => socket.emit('add-bot', { seat: seat.value, username: bot.value });
  const refresh = document.createElement('button'); refresh.textContent = '刷新账号';
  refresh.onclick = async () => { try { const response = await fetch('/api/bots'); if (!response.ok) throw Error('加载失败'); const items = await response.json(); state.botAccounts = items; populate(items); } catch { hint.textContent = '账号列表读取失败，请重试。'; } };
  const link = document.createElement('a'); link.href = '/bot-api.html'; link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'BOT 接入说明';
  panel.append(seat, bot, add, refresh, link);
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
  if (state.isHost) hostControls.append(addControl('修改房间名称', 'alt', () => {
    const name = prompt('房间名称（最多 40 字，留空使用房间码）', state.name || state.code);
    if (name !== null) socket.emit('rename-room', {name});
  }));
  if (state.canUndo) boardControls.append(addControl('撤回上一步', 'alt', () => socket.emit('undo-move')));
  if (state.phase === 'finished') {
    boardControls.append(addControl('下载完整棋谱', 'alt', () => openReplay(true)), addControl('复盘', 'alt', () => openReplay(false)));
  }
  const me = state.players.find((player) => player.seat === state.viewerSeat);
  if (state.isHost || state.viewerIsAdmin) {
    if (state.phase === "setup") {
      const full = state.players.every((player) => !player.empty);
      const allReady = full && state.players.every((player) => player.ready);
      hostControls.append(addControl("开始对局", "", () => socket.emit("start-game"), !allReady));
    }
    if (state.canToggleBotDebug) hostControls.append(addControl(state.botDebugEnabled ? "关闭 BOT 调试" : "BOT 调试：显示全部棋子", "alt", () => socket.emit("set-bot-debug", { enabled: !state.botDebugEnabled })));
    if (state.phase!=='finished' && (state.viewerIsAdmin || !(state.rated && state.phase === "playing"))) hostControls.append(addControl("关闭房间", "danger", () => { if (confirm("结束房间并保留棋谱与聊天？")) socket.emit("close-room"); }));
    if(state.viewerIsAdmin && state.phase==='playing')hostControls.append(addControl('结束比赛','danger',()=>{if(confirm('结束比赛并保留记录？本局不计分。'))socket.emit('admin-finish-room');}));
  }
  if (state.canToggleAdminReveal) boardControls.append(addControl(state.adminRevealEnabled ? "关闭明牌观战" : "开启明牌观战", "alt", () => socket.emit("toggle-admin-reveal", { enabled: !state.adminRevealEnabled })));
  if (state.phase === "setup") {
    if (state.spectator) {
      const label = document.createElement("strong"); label.textContent = "选择空方向落座："; boardControls.append(label);
      for (const player of state.players.filter(item => item.empty)) boardControls.append(addControl(boardMeta.seatNames[player.seat], "alt", () => socket.emit("take-seat", { seat: player.seat })));
      const hint = document.createElement("span"); hint.className = "setup-hint"; hint.textContent = "当前为离座状态，等价于观战"; boardControls.append(hint);
    } else {
      boardControls.append(addControl("随机布阵", "alt", () => { selected = null; socket.emit("randomize-setup"); }, me?.ready), addControl("左右翻转", "alt", () => { selected = null; socket.emit("mirror-setup"); }, me?.ready), addControl(me?.ready ? "取消准备" : "完成布阵", "", () => { selected = null; socket.emit("toggle-ready"); }), addControl("离座观战", "alt", () => { selected = null; socket.emit("leave-seat"); }));
      boardControls.append(addControl('保存阵型', 'alt', () => {
        const name = prompt('给阵型起个名字（最多保存三个）');
        if(name !== null) socket.emit('layout-save', {name});
      }, (state.layouts || []).length >= 3));
      for (const layout of state.layouts || []) {
        const group = document.createElement('div'); group.className = 'layout-entry';
        group.append(addControl(`使用：${layout.name}`, 'alt', () => socket.emit('layout-load', {index:layout.index}), me?.ready),
          addControl('删除', 'alt', () => {if(confirm(`删除阵型「${layout.name}」？`)) socket.emit('layout-delete', {index:layout.index});}));
        boardControls.append(group);
      }
      const hint = document.createElement("span"); hint.className = "setup-hint"; hint.textContent = me?.ready ? "等待其他玩家与房主开始" : "点击两枚棋子交换位置"; boardControls.append(hint);
    }
  } else if (state.spectator && state.phase === "playing") {
    const badge = document.createElement("strong"); badge.textContent = state.rated ? "排位观战 · 开局后不可接替" : "观战模式 · 可接替空缺方向："; boardControls.append(badge);
    if (!state.rated) for (const player of state.players.filter(item => item.empty)) boardControls.append(addControl(boardMeta.seatNames[player.seat], "alt", () => socket.emit("take-seat", { seat: player.seat })));
  } else if (state.spectator) {
    const badge = document.createElement("strong"); badge.textContent = `观战模式 · ${state.adminRevealEnabled ? "明牌观战已开启" : "棋子名称已隐藏"}`; boardControls.append(badge);
  } else if (state.phase === "playing" && !me?.eliminated) {
    if (!state.rated) boardControls.append(addControl("离座观战", "alt", () => { if (confirm("离座后棋子会原位保留，其他人可以接替。确定离座吗？")) socket.emit("leave-seat"); }));
    boardControls.append(addControl("认输", "danger", () => { if (confirm(`确认认输吗？${state.rated ? "本局将正常结算 Rating。" : ""}`)) socket.emit("resign"); }));
  } else if (state.phase === "finished") {
    const result = document.createElement("strong"); result.textContent = state.drawn||state.aborted?state.winner:`${state.winner}获胜`; boardControls.append(result);
  }
  if(state.phase==='playing'&&!state.spectator){
    const offer=state.drawOffer;
    if(!offer)boardControls.append(addControl('申请和棋','alt',()=>{if(confirm('申请和棋？需所有仍存活的玩家同意，和棋不计分。'))socket.emit('draw-vote',{accept:true});}));
    else {const label=document.createElement('span');label.textContent=`和棋申请：${offer.accepted.length}/${offer.required ?? state.capacity} 名存活玩家已同意`;boardControls.append(label);
      boardControls.append(addControl('同意和棋','alt',()=>socket.emit('draw-vote',{accept:true,offerId:offer.id}),offer.accepted.includes(state.viewerSeat)),addControl('拒绝和棋','alt',()=>socket.emit('draw-vote',{accept:false,offerId:offer.id})));}
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

if (window.marked) marked.use({ extensions: [{
  name: 'chatMath', level: 'inline',
  start: source => source.indexOf('$'),
  tokenizer(source) {
    const match = /^(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/.exec(source);
    if (match) return { type: 'chatMath', raw: match[0] };
  },
  renderer: token => escapeHtml(token.raw)
}] });
let emojiPicker = null;
function closeEmojiPicker() { emojiPicker?.remove(); emojiPicker=null; }
function openEmojiPicker(anchor, emit) {
  closeEmojiPicker();
  const panel=document.createElement('div');panel.className='emoji-picker';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','选择表情');
  emojiPicker=panel;
  let recent=[];try { recent=JSON.parse(localStorage.getItem('junqi-recent-emojis')||'[]').filter(e=>emojis.includes(e)).slice(0,24); } catch {}
  const tabs=document.createElement('div');tabs.className='emoji-tabs';
  const grid=document.createElement('div');grid.className='emoji-grid';
  const groups={'最近':recent,...Object.fromEntries(Object.entries(emojiGroups).map(([k,v])=>[k,v.split(' ')]))};
  const choose=key=>{
    grid.replaceChildren();for(const button of tabs.children)button.setAttribute('aria-pressed',String(button.textContent===key));
    if(!groups[key].length){const hint=document.createElement('span');hint.className='emoji-empty';hint.textContent='使用过的表情会显示在这里';grid.append(hint);}
    for(const emoji of groups[key]) {
      const button=document.createElement('button');button.type='button';button.textContent=emoji;button.title=emoji;button.setAttribute('aria-label',emoji);
      button.onclick=()=>{try{localStorage.setItem('junqi-recent-emojis',JSON.stringify([emoji,...recent.filter(e=>e!==emoji)].slice(0,24)));}catch{}emit(emoji);closeEmojiPicker();if(anchor.isConnected)anchor.focus({preventScroll:true});};grid.append(button);
    }
  };
  for(const key of Object.keys(groups)){const button=document.createElement('button');button.type='button';button.textContent=key;button.onclick=()=>choose(key);tabs.append(button);}
  panel.append(tabs,grid);document.body.append(panel);choose(recent.length?'最近':'表情');
  const rect=anchor.getBoundingClientRect();
  panel.style.left=Math.max(8,Math.min(rect.left,window.innerWidth-panel.offsetWidth-8))+'px';
  panel.style.top=Math.max(8,Math.min(rect.bottom+5,window.innerHeight-panel.offsetHeight-8))+'px';
  tabs.querySelector('button').focus();
}
document.addEventListener('pointerdown',event=>{if(emojiPicker&&!emojiPicker.contains(event.target)&&!event.target.closest('.reaction-add'))closeEmojiPicker();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeEmojiPicker();});
window.addEventListener('resize',closeEmojiPicker);
function isAdminNow() { return !!auth?.admin; }
function canModerateChat(scope, item) {
  if (item.admin && item.name !== auth?.username) return false;
  if (scope === 'lobby') return isAdminNow();
  return !!(state?.isHost || state?.viewerIsAdmin);
}
function emitModerate(scope, action, extra = {}) {
  socket.emit(scope === 'lobby' ? 'lobby-moderate' : 'chat-moderate', { action, ...extra, authToken: auth?.token });
}
function chatAction(label, action, title = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = label;
  if (title) button.title = title;
  button.onclick = action;
  return button;
}
function buildChatActions(scope, item) {
  const actions = document.createElement('span');
  actions.className = 'chat-actions';
  if (item.recalled) return actions;
  const isSelf = item.name === auth?.username;
  if (isSelf && item.time && Date.now() - item.time < 5 * 60 * 1000) {
    actions.append(chatAction('撤回', () => socket.emit('recall-own', { scope, id: item.id }), '5 分钟内可撤回自己的消息'));
  } else if (canModerateChat(scope, item)) {
    actions.append(chatAction('撤回', () => emitModerate(scope, 'recall', { id: item.id })));
    if (!isSelf) {
      const muted = scope === 'lobby' ? lobbyMuted : (state?.chatMuted || []);
      actions.append(chatAction(muted.includes(item.name) ? '解除禁言' : '禁言', () => emitModerate(scope, muted.includes(item.name) ? 'unmute' : 'mute', { username: item.name })));
    }
  }
  return actions;
}
const renderedChats=new WeakMap();
const forceChatBottom=new WeakSet();
const observedChatLists=new WeakSet();
const chatSnapshots=new WeakMap();
function renderReactions(row,item,scope){
  row.querySelector('.chat-reactions')?.remove();
  if(item.recalled||scope==='announcement')return;
  const reactions=document.createElement('div');reactions.className='chat-reactions';
  const emit=emoji=>socket.emit('chat-react',{scope,id:item.id,emoji,authToken:auth?.token});
  for(const [emoji,users]of Object.entries(item.reactions||{}))if(users.length){
    const button=document.createElement('button');button.type='button';button.textContent=`${emoji} ${users.length}`;
    button.title=users.join('、');button.setAttribute('aria-pressed',String(users.includes(auth?.username)));button.onclick=()=>emit(emoji);reactions.append(button);
  }
  const picker=document.createElement('button');picker.type='button';picker.className='reaction-add';picker.textContent='☺+';picker.title='添加表情';picker.onclick=()=>openEmojiPicker(picker,emit);reactions.append(picker);row.append(reactions);
}
function observeChatSize(list){
  if(observedChatLists.has(list)||!window.ResizeObserver)return;
  observedChatLists.add(list);
  new ResizeObserver(()=>{if(list._followChatBottom)list.scrollTop=list.scrollHeight;}).observe(list);
  for(const event of ['wheel','touchstart','pointerdown'])list.addEventListener(event,()=>{list._followChatBottom=false;},{passive:true});
}
function renderChat(messages = state?.chat || [], list = $('#chat-list')) {
  const showAvatars=localStorage.getItem('junqi-chat-avatars')!=='0';
  const stamp=JSON.stringify([messages,showAvatars,state?.isHost,state?.viewerIsAdmin,state?.chatMuted,auth?.admin,lobbyMuted,bannedUsers]);if(renderedChats.get(list)===stamp)return;renderedChats.set(list,stamp);
  const scopeKey=list.id==='announcement-list'?'announcement':list.id==='lobby-chat-list'?'lobby':'room';
  const contentStamp=JSON.stringify([messages.map(({reactions,...item})=>item),showAvatars,state?.isHost,state?.viewerIsAdmin,state?.chatMuted,auth?.admin,lobbyMuted,bannedUsers]);
  if(chatSnapshots.get(list)===contentStamp){
    const top=list.scrollTop,bottom=list.scrollHeight-list.clientHeight-top<24;
    const anchor=[...list.children].find(row=>row.getBoundingClientRect().bottom>list.getBoundingClientRect().top);
    const offset=anchor?anchor.getBoundingClientRect().top:0;
    messages.forEach((item,i)=>renderReactions(list.children[i],item,scopeKey));
    list.scrollTop=bottom?list.scrollHeight:top+(anchor?anchor.getBoundingClientRect().top-offset:0);
    return;
  }
  chatSnapshots.set(list,contentStamp);
  const oldTop=list.scrollTop;
  const wasAtBottom=list.scrollHeight-list.clientHeight-list.scrollTop<24;
  const shouldFollow=wasAtBottom||forceChatBottom.has(list);
  observeChatSize(list);list._followChatBottom=shouldFollow;
  forceChatBottom.delete(list);
  releaseChatFolds(list);
  list.replaceChildren();
  for (const item of messages) {
    const row = document.createElement("div");
    row.className = "chat-item";
    const scope = list.id === 'announcement-list' ? 'announcement' : list.id === 'lobby-chat-list' ? 'lobby' : 'room';
    const meta = document.createElement('div'); meta.className = 'chat-meta';
    const name = document.createElement('a'); name.href='/profile/'+encodeURIComponent(item.name); name.textContent = item.name; name.dataset.username=item.name;
    colorRating(name, item.rating ?? 1500);
    meta.append(name);
    if(showAvatars){const avatarLink=document.createElement('a');avatarLink.href='/profile/'+encodeURIComponent(item.name);avatarLink.className='avatar-profile-link';avatarLink.append(avatarImage(item.name,item.avatar));meta.prepend(avatarLink);}
    const time=messageTime(item.time);if(time)meta.append(time);meta.append(copySourceButton(item.text));
    if (scope !== 'announcement') meta.append(buildChatActions(scope, item));
    else if (auth?.admin) {
      const remove = addControl('删除', 'alt', async () => {
        const response = await fetch(`/api/announcements/${item.id}`, {method:'DELETE', headers:{Authorization:`Bearer ${auth.token}`}});
        if(!response.ok) showToast((await response.json()).error);
      }); remove.className = 'chat-recall'; meta.append(remove);
    }
    const body = document.createElement('div'); body.className = 'chat-content';
    renderRichChatBody(body,item.text,auth?.token);
    row.append(meta,body);attachChatFold(row,body,`${scope}:${item.id}`);
    if (!item.recalled && scope !== 'announcement') {
      const reactions = document.createElement('div'); reactions.className = 'chat-reactions';
      const emit = emoji => socket.emit('chat-react', { scope, id:item.id, emoji, authToken:auth?.token });
      for (const [emoji,users] of Object.entries(item.reactions || {})) if(users.length) {
        const button = document.createElement('button'); button.type='button'; button.textContent=`${emoji} ${users.length}`;
        button.title=users.join('、'); button.setAttribute('aria-pressed',String(users.includes(auth?.username))); button.onclick=()=>emit(emoji); reactions.append(button);
      }
      const picker=document.createElement('button');picker.type='button';picker.className='reaction-add';picker.textContent='☺+';picker.title='添加表情';picker.setAttribute('aria-label','添加表情');
      picker.onclick=()=>openEmojiPicker(picker,emit);reactions.append(picker);row.append(reactions);
    }
    list.append(row);
  }
  list.scrollTop=shouldFollow?list.scrollHeight:oldTop;
  requestAnimationFrame(()=>{if(list._followChatBottom)list.scrollTop=list.scrollHeight;});
  if(list.id==='lobby-chat-list'){
    let panel=$('#lobby-muted-users');if(!panel){panel=document.createElement('div');panel.id='lobby-muted-users';panel.className='chat-muted-users';list.after(panel);}
    renderMutedUsers(panel,isAdminNow()?lobbyMuted:[],username=>emitModerate('lobby','unmute',{username}));
  }
  if(list.id==='chat-list') {
    $('#room-muted-users')?.remove();
    if(state?.isHost || state?.viewerIsAdmin) {
      const panel=document.createElement('div');panel.id='room-muted-users';panel.className='chat-muted-users';renderMutedUsers(panel,state.chatMuted||[],username=>socket.emit('chat-moderate',{action:'unmute',username}));
      list.after(panel);
    }
  }
}

socket.on('lobby-chat', messages => { lobbyChatState = messages || []; renderChat(lobbyChatState, $('#lobby-chat-list')); });
let announcementState = [];
(async()=>{try{const response=await fetch('/api/announcements');if(response.ok){announcementState=await response.json();renderChat(announcementState,$('#announcement-list'));}}catch{}})();
socket.on('announcements', messages => {
  announcementState = messages || []; renderChat(announcementState, $('#announcement-list'));
  $('#announcement-form').hidden = !auth?.admin;
});
attachImages($('#announcement-input'));
$('#announcement-form').onsubmit = async event => {
  event.preventDefault(); const input = $('#announcement-input');
  try {
    const text = await composeImages(input, 'lobby', auth?.token);
    const response = await fetch('/api/announcements', {method:'POST', headers:{Authorization:`Bearer ${auth?.token || ''}`, 'Content-Type':'application/json'}, body:JSON.stringify({text})});
    if(!response.ok) throw Error((await response.json()).error);
    input.value = ''; clearImages(input);
  } catch(error) {showToast(error.message);}
};
$('#announcement-input').onkeydown = event => {if(event.ctrlKey && event.key === 'Enter'){event.preventDefault(); $('#announcement-form').requestSubmit();}};
attachImages($('#lobby-chat-input'));attachImages($('#chat-input'));
$('#lobby-chat-form').onsubmit = async event => {
  event.preventDefault();
  if (!auth?.token) return showToast('请先登录账号');
  const input = $('#lobby-chat-input');
  if(input.dataset.sending)return;input.dataset.sending='1';
  try {const text=await composeImages(input,'lobby',auth.token);if(!text)return;
  forceChatBottom.add($('#lobby-chat-list'));
  socket.emit('lobby-chat-message', { text, authToken: auth.token });input.value='';clearImages(input);
  }catch(error){showToast(error.message);}finally{delete input.dataset.sending;}
};
$('#lobby-chat-input').onkeydown = event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#lobby-chat-form').requestSubmit(); }
};
$('#lobby-chat-expand').onclick = () => {
  const expanded = $('#lobby-chat-panel').classList.toggle('chat-expanded');
  $('#lobby-chat-expand').textContent = expanded ? '恢复大小' : '放大聊天';
};
$('#lobby-mentions').textContent = mentionButton.textContent;
$('#lobby-mentions').onclick = async () => {
  await mentionButton.onclick();
  $('#lobby-mentions').textContent = mentionButton.textContent;
};
async function openReplay(download) {
  const code = state.code;
  try {
    const response = await fetch(`/api/rooms/${code}/replay`,{headers:{Authorization:`Bearer ${auth?.token||''}`}});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (download) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `junqi-${code}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    document.querySelector('#replay-dialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.id = 'replay-dialog';
    dialog.style.cssText = 'width: min(95vw,1000px);max-height:95vh;background:#111;color:#eee;border:1px solid #666';
    const toolbar = document.createElement('div'); toolbar.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap';
    const label = document.createElement('span');
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(data.frames.length - 1); slider.value = '0';
    const canvas = document.createElement('div');
    const show = () => {
      const index = Number(slider.value), live = state;
      state = { ...live, ...data.frames[index].state };
      try {
        renderBoard(); const copy = boardSvg.cloneNode(true); copy.removeAttribute('id');
        copy.querySelectorAll('.piece-guess').forEach(el=>el.remove());
        copy.querySelectorAll('[tabindex]').forEach(el => {el.removeAttribute('tabindex'); el.removeAttribute('role');});
        copy.classList.add('replay-board');
        copy.style.cssText = 'display:block;width:100%;height:75vh'; canvas.replaceChildren(copy);
      }
      finally { state = live; renderBoard(); }
      label.textContent = `${index === 0 ? '开局' : '步骤 ' + index} / ${data.frames.length - 1}`;
    };
    toolbar.append(addControl('上一步', 'alt', () => { slider.value = String(Math.max(0, Number(slider.value) - 1)); show(); }), slider,
      addControl('下一步', 'alt', () => { slider.value = String(Math.min(data.frames.length - 1, Number(slider.value) + 1)); show(); }), label,
      addControl('关闭复盘', 'alt', () => dialog.close()));
    slider.oninput = show;
    dialog.append(toolbar, canvas); document.body.append(dialog); dialog.showModal(); show();
  } catch (error) { showToast(error.message || '棋谱加载失败'); }
}
function render() {
  if (!state) return;
  $("#room-code-label").textContent = `${state.name || state.code} (${state.code})`;
  $("#mode-label").textContent = `${state.phase==='setup'?'自动计分':state.rated ? "Rated" : "不计分"} · ${state.mode === "alliance" ? "对家结盟" : "各自为战"}`;
  const phases = { setup: "布阵中", playing: "对局进行中", finished: "对局结束" };
  $("#phase-label").textContent = phases[state.phase];
  if (state.phase === "playing") {
    const turnName = boardMeta?.seatNames[state.turn] || state.turn;
    const bot = state.players.find(p => p.seat === state.turn && p.isBot);
    $("#turn-banner").textContent = bot ? `${turnName} BOT 等待提交（限时 5 秒）` : state.turn === state.viewerSeat ? "轮到你行动" : `等待${turnName}行动`;
  } else if (state.phase === "finished") {
    $("#turn-banner").textContent = state.drawn||state.aborted?state.winner:`${state.winner}获胜`;
  } else {
    $("#turn-banner").textContent = "完成布阵并准备，等待房主开局";
  }
  if (state.spectator) $("#turn-banner").textContent = `${state.botDebugEnabled ? "BOT 调试观战 · 已显示全部棋子" : "正在观战"} · ${$("#turn-banner").textContent}`;
  renderPlayers();
  renderBoard();
  renderControls();
  renderLogs();
  renderChat();
}

$('#chat-expand').onclick = () => {
  const expanded = $('#chat-list').closest('.chat-panel').classList.toggle('chat-expanded');
  $('#chat-expand').textContent = expanded ? '返回棋盘' : '放大聊天';
  $('#chat-expand').setAttribute('aria-pressed', String(expanded));
};
$('#chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#chat-form').requestSubmit(); }
});
$("#chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  if(!state?.code||!auth?.token)return showToast('请登录并进入房间');
  if(input.dataset.sending)return;input.dataset.sending='1';
  try {const text=await composeImages(input,state.code,auth.token);if(!text)return;
  forceChatBottom.add($('#chat-list'));
  socket.emit("chat-message", { text });input.value="";clearImages(input);
  }catch(error){showToast(error.message);}finally{delete input.dataset.sending;}
});

$("#room-code-button").addEventListener("click", async () => {
  const url = `${location.origin}/room/${state.code}`;
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
  const button = $('#leave-button');
  button.disabled = true;
  let completed=false;
  const timeout=setTimeout(()=>{if(!completed){completed=true;button.disabled=false;showToast('离开尚未确认，请检查连接后重试');}},8000);
  socket.emit("leave-room", {code:state?.code}, reply => {
    if(completed)return;completed=true;clearTimeout(timeout);
    button.disabled = false;
    if (!reply?.ok) return showToast(reply?.error||'离开尚未确认，请检查连接后重试');
    clearSession();
    window.location.assign('/');
  });
});

socket.on("account-deleted", () => {
  localStorage.removeItem("junqi-auth");
  localStorage.removeItem("junqi-session");
  window.location.reload();
});

function refreshPreferences(){
  mentionNotifications=localStorage.getItem('junqi-mention-notifications')==='1';turnNotifications=localStorage.getItem('junqi-turn-notifications')==='1';
  renderMentionSetting();updateNotificationButton();$('#lobby-mentions').textContent=mentionButton.textContent;
  if(!turnNotifications)activeTurnNotification?.close();
  if(state){renderPlayers();renderBoard();renderChat();}renderChat(lobbyChatState,$('#lobby-chat-list'));renderChat(announcementState,$('#announcement-list'));
}
window.addEventListener('storage',e=>{if(['junqi-chat-avatars','junqi-turn-notifications','junqi-mention-notifications'].includes(e.key))refreshPreferences();});
window.addEventListener('junqi-preferences',refreshPreferences);

const boardOpacity=$('#board-opacity');
function applyBoardOpacity(){
  const value=Math.max(25,Math.min(100,Number(boardOpacity.value)||100));
  document.documentElement.style.setProperty('--board-opacity',String(value/100));
  $('#board-opacity-value').value=`${value}%`;
  localStorage.setItem('junqi-board-opacity',String(value));
}
boardOpacity.value=localStorage.getItem('junqi-board-opacity')||'100';
boardOpacity.addEventListener('input',applyBoardOpacity);applyBoardOpacity();

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
