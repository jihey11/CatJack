const $ = (selector) => document.querySelector(selector);

const els = {
  authView: $("#authView"), appView: $("#appView"), lobbyView: $("#lobbyView"), roomView: $("#roomView"),
  loginTab: $("#loginTab"), signupTab: $("#signupTab"), loginForm: $("#loginForm"), signupForm: $("#signupForm"),
  loginUsername: $("#loginUsername"), loginPassword: $("#loginPassword"),
  signupUsername: $("#signupUsername"), signupNickname: $("#signupNickname"), signupPassword: $("#signupPassword"),
  headerChips: $("#headerChips"), welcomeNickname: $("#welcomeNickname"), logoutButton: $("#logoutButton"),
  logoButton: $("#logoButton"), rankingButton: $("#rankingButton"), historyButton: $("#historyButton"),
  createRoomForm: $("#createRoomForm"), roomName: $("#roomName"), maxPlayers: $("#maxPlayers"), minBet: $("#minBet"),
  roomCodeInput: $("#roomCodeInput"), joinCodeButton: $("#joinCodeButton"), quickJoinButton: $("#quickJoinButton"), roomList: $("#roomList"),
  roomStatusBadge: $("#roomStatusBadge"), roomCodeBadge: $("#roomCodeBadge"), roomTitle: $("#roomTitle"), roomSubtext: $("#roomSubtext"),
  copyCodeButton: $("#copyCodeButton"), leaveRoomButton: $("#leaveRoomButton"), dealerScore: $("#dealerScore"), dealerCats: $("#dealerCats"),
  turnBanner: $("#turnBanner"), playersGrid: $("#playersGrid"), waitingControls: $("#waitingControls"), playingControls: $("#playingControls"),
  resultControls: $("#resultControls"), betInput: $("#betInput"), setBetButton: $("#setBetButton"), readyButton: $("#readyButton"),
  startButton: $("#startButton"), hitButton: $("#hitButton"), standButton: $("#standButton"), resultSummary: $("#resultSummary"),
  nextRoundButton: $("#nextRoundButton"), chatMessages: $("#chatMessages"), chatForm: $("#chatForm"), chatInput: $("#chatInput"),
  modal: $("#modal"), modalTitle: $("#modalTitle"), modalBody: $("#modalBody"), modalClose: $("#modalClose"), toast: $("#toast")
};

let token = localStorage.getItem("catjack_token") || "";
let currentUser = null;
let socket = null;
let currentRoom = null;
let availableRooms = [];
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle("error", isError);
  els.toast.classList.add("show");
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
}

async function api(url, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "요청 처리 중 오류가 발생했습니다.");
  return data;
}

function setAuthTab(mode) {
  const login = mode === "login";
  els.loginTab.classList.toggle("active", login);
  els.signupTab.classList.toggle("active", !login);
  els.loginForm.classList.toggle("hidden", !login);
  els.signupForm.classList.toggle("hidden", login);
}

function showLobby() {
  currentRoom = null;
  sessionStorage.removeItem("catjack_room");
  els.roomView.classList.add("hidden");
  els.lobbyView.classList.remove("hidden");
}

function showRoom() {
  els.lobbyView.classList.add("hidden");
  els.roomView.classList.remove("hidden");
}

function saveSession(authData) {
  token = authData.token;
  currentUser = authData.user;
  localStorage.setItem("catjack_token", token);
}

function logout() {
  token = "";
  currentUser = null;
  currentRoom = null;
  localStorage.removeItem("catjack_token");
  sessionStorage.removeItem("catjack_room");
  if (socket) socket.disconnect();
  socket = null;
  els.appView.classList.add("hidden");
  els.authView.classList.remove("hidden");
  setAuthTab("login");
}

async function enterApp() {
  const data = await api("/api/me");
  currentUser = data.user;
  els.authView.classList.add("hidden");
  els.appView.classList.remove("hidden");
  els.welcomeNickname.textContent = currentUser.nickname;
  els.headerChips.textContent = formatNumber(currentUser.chips);
  showLobby();
  // WebSocket 핸드셰이크를 기다리지 않고 방 목록을 먼저 가져옵니다.
  refreshRoomListHttp();
  connectSocket();
}

async function refreshRoomListHttp() {
  try {
    const data = await api("/api/rooms");
    availableRooms = Array.isArray(data.rooms) ? data.rooms : [];
    renderRoomList();
  } catch (_error) {
    // WebSocket이 연결되면 rooms-list 이벤트가 다시 갱신하므로 여기서는 조용히 무시합니다.
  }
}

function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({
    auth: { token },
    // Vercel에서는 Socket.IO 기본 XHR polling이 인스턴스 사이에서 끊길 수 있으므로
    // WebSocket으로 바로 연결합니다.
    transports: ["websocket"],
    upgrade: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 10000
  });

  socket.on("connect", () => {
    const savedRoom = sessionStorage.getItem("catjack_room");
    if (savedRoom) {
      socket.emit("join-room", { code: savedRoom }, (result) => {
        if (!result?.ok) {
          sessionStorage.removeItem("catjack_room");
          showLobby();
        }
      });
    }
  });

  let connectionErrorShown = false;
  socket.on("connect_error", (error) => {
    const authError = /로그인|사용자|만료/.test(error?.message || "");
    if (authError) {
      showToast(error.message, true);
      return;
    }
    if (!connectionErrorShown) {
      connectionErrorShown = true;
      showToast("실시간 연결이 잠시 끊겼습니다. 자동으로 다시 연결합니다.", true);
    }
  });

  socket.io.on("reconnect", () => {
    connectionErrorShown = false;
    refreshRoomListHttp();
    showToast("실시간 서버에 다시 연결되었습니다.");
  });

  socket.on("rooms-list", (rooms) => {
    availableRooms = Array.isArray(rooms) ? rooms : [];
    renderRoomList();
  });

  socket.on("room-state", (room) => {
    currentRoom = room;
    sessionStorage.setItem("catjack_room", room.code);
    showRoom();
    renderRoom();
  });

  socket.on("game-error", ({ message }) => showToast(message, true));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}

function emitAck(event, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error("서버와 연결되어 있지 않습니다."));
    socket.emit(event, payload, (result) => {
      if (!result?.ok) return reject(new Error(result?.error || "요청에 실패했습니다."));
      resolve(result);
    });
  });
}

function renderRoomList() {
  if (!availableRooms.length) {
    els.roomList.innerHTML = `<div class="empty-state">현재 참가 가능한 공개방이 없습니다.<br>새 방을 만들어 친구를 초대해 보세요.</div>`;
    return;
  }

  els.roomList.innerHTML = availableRooms.map((room) => `
    <article class="room-item">
      <div>
        <h4>${escapeHtml(room.name)}</h4>
        <p>${room.players}/${room.maxPlayers}명 · 최소 ${formatNumber(room.minBet)} CHIP · 코드 ${escapeHtml(room.code)}</p>
      </div>
      <button class="secondary small room-join" data-code="${escapeHtml(room.code)}" type="button">참가</button>
    </article>
  `).join("");

  document.querySelectorAll(".room-join").forEach((button) => {
    button.addEventListener("click", () => joinRoom(button.dataset.code));
  });
}

async function joinRoom(code) {
  try {
    const normalized = String(code || "").trim().toUpperCase();
    if (!normalized) throw new Error("방 코드를 입력하세요.");
    await emitAck("join-room", { code: normalized });
  } catch (error) {
    showToast(error.message, true);
  }
}

const catFaces = {
  ACE: "🐈‍⬛", "2": "🐱", "3": "😺", "4": "😸", "5": "😻", "6": "😼",
  "7": "😽", "8": "🙀", "9": "😹", "10": "🐈", JACK: "😼", QUEEN: "😺", KING: "🐱"
};
const valueLabels = { ACE: "A", JACK: "J", QUEEN: "Q", KING: "K" };
const valueAccessories = { ACE: "🌙", JACK: "🎩", QUEEN: "🎀", KING: "👑" };
const suitAccessories = { SPADES: "🖤", HEARTS: "💗", DIAMONDS: "💎", CLUBS: "🍀" };

function catHtml(card, small = false) {
  if (!card || card.hidden) {
    return `<div class="cat-token hidden-cat ${small ? "small-cat" : ""}"><span class="cat-face">🐾</span></div>`;
  }
  const value = valueLabels[card.value] || card.value;
  const face = catFaces[card.value] || "🐱";
  const accessory = valueAccessories[card.value] || "";
  const suit = suitAccessories[card.suit] || "🐾";
  return `
    <div class="cat-token ${small ? "small-cat" : ""}" title="${escapeHtml(card.value)} / ${escapeHtml(card.suit)}">
      <span class="cat-value">${escapeHtml(value)}</span>
      <span class="cat-accessory">${accessory}</span>
      <span class="cat-face">${face}</span>
      <span class="cat-suit">${suit}</span>
    </div>`;
}

function resultLabel(result) {
  return ({ WIN: "WIN", LOSE: "LOSE", DRAW: "DRAW", BLACKJACK: "BLACKJACK!" })[result] || "";
}

function resultClass(result) {
  if (["WIN", "BLACKJACK"].includes(result)) return "result-win";
  if (result === "LOSE") return "result-lose";
  if (result === "DRAW") return "result-draw";
  return "";
}

function statusText(status) {
  return ({ WAITING: "WAITING", PLAYING: "PLAYING", DEALER_TURN: "DEALER", RESULT: "RESULT" })[status] || status;
}

function roomSubtitle(room) {
  if (room.status === "WAITING") return `최소 배팅 ${formatNumber(room.minBet)} CHIP · 최대 ${room.maxPlayers}명`;
  if (room.status === "PLAYING") return "각자 딜러를 상대로 21에 가까운 점수를 만드세요.";
  if (room.status === "DEALER_TURN") return "모든 플레이어의 턴이 끝났습니다. 딜러가 진행합니다.";
  return "이번 판 결과가 확정되었습니다.";
}

function renderRoom() {
  if (!currentRoom || !currentUser) return;
  const room = currentRoom;
  const me = room.players.find((p) => p.userId === currentUser.id);
  if (!me) {
    showLobby();
    return;
  }

  currentUser.chips = me.chips;
  els.headerChips.textContent = formatNumber(me.chips);
  els.roomStatusBadge.textContent = statusText(room.status);
  els.roomCodeBadge.textContent = room.code;
  els.roomTitle.textContent = room.name;
  els.roomSubtext.textContent = roomSubtitle(room);
  els.dealerScore.textContent = room.dealerScore ?? "?";
  els.dealerCats.innerHTML = room.dealerCards.length
    ? room.dealerCards.map((card) => catHtml(card)).join("")
    : `<div class="empty-state">게임이 시작되면 딜러 고양이가 등장합니다.</div>`;

  renderPlayers(room);
  renderTurn(room, me);
  renderControls(room, me);
  renderChat(room);

  const canLeave = ["WAITING", "RESULT"].includes(room.status);
  els.leaveRoomButton.disabled = !canLeave;
  els.leaveRoomButton.title = canLeave ? "" : "게임 진행 중에는 나갈 수 없습니다.";
}

function renderPlayers(room) {
  els.playersGrid.innerHTML = room.players.map((player) => {
    const isMe = player.userId === currentUser.id;
    const isCurrent = room.currentTurnUserId === player.userId;
    const natural = player.cards?.length === 2 && player.score === 21 && !player.result;
    const stateLabel = player.result
      ? `<span class="mini-pill ${resultClass(player.result)}">${resultLabel(player.result)} ${player.chipChange >= 0 ? "+" : ""}${formatNumber(player.chipChange)}</span>`
      : player.ready && room.status === "WAITING"
        ? `<span class="mini-pill ready-pill">READY</span>`
        : natural
          ? `<span class="mini-pill result-win">BLACKJACK</span>`
          : `<span class="mini-pill">${escapeHtml(player.state || "WAITING")}</span>`;

    return `
      <article class="player-card ${isMe ? "me" : ""} ${isCurrent ? "current" : ""}">
        <div class="player-head">
          <div>
            <div class="player-name">${player.connected ? "🐱" : '<span class="offline-dot">●</span>'} ${escapeHtml(player.nickname)} ${isMe ? "(나)" : ""}</div>
            <div class="player-stats">
              <span class="mini-pill">🪙 ${formatNumber(player.chips)}</span>
              <span class="mini-pill">BET ${formatNumber(player.bet)}</span>
              ${stateLabel}
            </div>
          </div>
          <strong>${player.score ?? "-"}</strong>
        </div>
        <div class="player-cats">
          ${player.cards?.length ? player.cards.map((card) => catHtml(card, true)).join("") : '<span class="empty-state" style="width:100%;padding:18px">아직 고양이가 없습니다.</span>'}
        </div>
      </article>`;
  }).join("");
}

function renderTurn(room, me) {
  els.turnBanner.classList.remove("my-turn");
  if (room.status === "WAITING") {
    const ready = room.players.filter((p) => p.ready).length;
    els.turnBanner.textContent = `${ready}/${room.players.length}명 READY · 최소 2명이 필요합니다.`;
    return;
  }
  if (room.status === "DEALER_TURN") {
    els.turnBanner.textContent = "딜러가 고양이를 뽑는 중입니다...";
    return;
  }
  if (room.status === "RESULT") {
    els.turnBanner.textContent = "게임 종료! 결과를 확인하세요.";
    return;
  }

  const current = room.players.find((p) => p.userId === room.currentTurnUserId);
  if (!current) {
    els.turnBanner.textContent = "다음 턴을 준비 중입니다.";
  } else if (current.userId === me.userId) {
    els.turnBanner.textContent = "당신의 차례입니다! HIT 또는 STAND를 선택하세요.";
    els.turnBanner.classList.add("my-turn");
  } else {
    els.turnBanner.textContent = `${current.nickname}님의 차례입니다.`;
  }
}

function renderControls(room, me) {
  const waiting = room.status === "WAITING";
  const playing = room.status === "PLAYING" || room.status === "DEALER_TURN";
  const result = room.status === "RESULT";

  els.waitingControls.classList.toggle("hidden", !waiting);
  els.playingControls.classList.toggle("hidden", !playing);
  els.resultControls.classList.toggle("hidden", !result);

  if (waiting) {
    els.betInput.min = String(room.minBet);
    if (document.activeElement !== els.betInput) els.betInput.value = String(me.bet || room.minBet);
    els.readyButton.textContent = me.ready ? "READY ✓" : "READY";
    els.readyButton.classList.toggle("on", me.ready);
    els.setBetButton.disabled = me.ready;
    els.betInput.disabled = me.ready;

    const isHost = room.hostId === currentUser.id;
    els.startButton.classList.toggle("hidden", !isHost);
    const allReady = room.players.length >= 2 && room.players.every((p) => p.ready);
    els.startButton.disabled = !allReady;
  }

  if (playing) {
    const myTurn = room.status === "PLAYING" && room.currentTurnUserId === currentUser.id && me.state === "ACTIVE";
    els.hitButton.disabled = !myTurn;
    els.standButton.disabled = !myTurn;
  }

  if (result) {
    const label = resultLabel(me.result);
    const sign = me.chipChange > 0 ? "+" : "";
    els.resultSummary.innerHTML = `<span class="${resultClass(me.result)}">${escapeHtml(label)}</span> · ${sign}${formatNumber(me.chipChange)} CHIP`;
    els.nextRoundButton.classList.toggle("hidden", room.hostId !== currentUser.id);
  }
}

function renderChat(room) {
  const nearBottom = els.chatMessages.scrollHeight - els.chatMessages.scrollTop - els.chatMessages.clientHeight < 80;
  els.chatMessages.innerHTML = room.messages?.length
    ? room.messages.map((message) => `
      <div class="chat-message ${message.userId === currentUser.id ? "mine" : ""}">
        <strong>${escapeHtml(message.nickname)}</strong>
        <span>${escapeHtml(message.text)}</span>
      </div>`).join("")
    : `<div class="empty-state">첫 메시지를 보내보세요.</div>`;
  if (nearBottom) els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function openModal(title, html) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = html;
  els.modal.classList.remove("hidden");
}

function closeModal() {
  els.modal.classList.add("hidden");
}

async function showRanking() {
  try {
    const { ranking } = await api("/api/ranking");
    openModal("CHIP 랭킹", `
      <table class="data-table">
        <thead><tr><th>순위</th><th>닉네임</th><th>CHIP</th><th>승리</th><th>BLACKJACK</th></tr></thead>
        <tbody>${ranking.map((row) => `<tr><td>${row.rank}</td><td>${escapeHtml(row.nickname)}</td><td>${formatNumber(row.chips)}</td><td>${row.wins}</td><td>${row.blackjacks}</td></tr>`).join("")}</tbody>
      </table>`);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function showHistory() {
  try {
    const [{ user }, { history }] = await Promise.all([api("/api/me"), api("/api/history")]);
    currentUser = user;
    els.headerChips.textContent = formatNumber(user.chips);
    const stats = user.stats || {};
    openModal("내 게임 기록", `
      <div class="stat-grid">
        <div class="stat-box"><span>보유 CHIP</span><strong>${formatNumber(user.chips)}</strong></div>
        <div class="stat-box"><span>총 게임</span><strong>${stats.games || 0}</strong></div>
        <div class="stat-box"><span>승리</span><strong>${stats.wins || 0}</strong></div>
        <div class="stat-box"><span>패배</span><strong>${stats.losses || 0}</strong></div>
        <div class="stat-box"><span>BLACKJACK</span><strong>${stats.blackjacks || 0}</strong></div>
        <div class="stat-box"><span>최고 연승</span><strong>${stats.bestWinStreak || 0}</strong></div>
      </div>
      <div style="height:18px"></div>
      ${history.length ? `
        <table class="data-table">
          <thead><tr><th>날짜</th><th>방</th><th>결과</th><th>점수</th><th>딜러</th><th>변동</th></tr></thead>
          <tbody>${history.map((row) => `<tr>
            <td>${new Date(row.createdAt).toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
            <td>${escapeHtml(row.roomName)}</td>
            <td class="${resultClass(row.result)}">${escapeHtml(resultLabel(row.result))}</td>
            <td>${row.score}</td><td>${row.dealerScore}</td>
            <td>${row.chipChange > 0 ? "+" : ""}${formatNumber(row.chipChange)}</td>
          </tr>`).join("")}</tbody>
        </table>` : '<div class="empty-state">아직 게임 기록이 없습니다.</div>'}`);
  } catch (error) {
    showToast(error.message, true);
  }
}

els.loginTab.addEventListener("click", () => setAuthTab("login"));
els.signupTab.addEventListener("click", () => setAuthTab("signup"));

els.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: els.loginUsername.value, password: els.loginPassword.value })
    });
    saveSession(data);
    await enterApp();
  } catch (error) {
    showToast(error.message, true);
  }
});

els.signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ username: els.signupUsername.value, nickname: els.signupNickname.value, password: els.signupPassword.value })
    });
    saveSession(data);
    await enterApp();
  } catch (error) {
    showToast(error.message, true);
  }
});

els.createRoomForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await emitAck("create-room", {
      name: els.roomName.value,
      maxPlayers: Number(els.maxPlayers.value),
      minBet: Number(els.minBet.value)
    });
  } catch (error) {
    showToast(error.message, true);
  }
});

els.joinCodeButton.addEventListener("click", () => joinRoom(els.roomCodeInput.value));
els.roomCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom(els.roomCodeInput.value);
});

els.quickJoinButton.addEventListener("click", () => {
  if (!availableRooms.length) return showToast("현재 참가 가능한 방이 없습니다.", true);
  joinRoom(availableRooms[0].code);
});

els.setBetButton.addEventListener("click", async () => {
  try {
    await emitAck("set-bet", { bet: Number(els.betInput.value) });
    showToast("배팅 금액을 변경했습니다.");
  } catch (error) { showToast(error.message, true); }
});

els.readyButton.addEventListener("click", async () => {
  try {
    const me = currentRoom?.players.find((p) => p.userId === currentUser.id);
    await emitAck("set-ready", { ready: !me?.ready });
  } catch (error) { showToast(error.message, true); }
});

els.startButton.addEventListener("click", async () => {
  try { await emitAck("start-game"); }
  catch (error) { showToast(error.message, true); }
});

els.hitButton.addEventListener("click", async () => {
  try { await emitAck("player-hit"); }
  catch (error) { showToast(error.message, true); }
});

els.standButton.addEventListener("click", async () => {
  try { await emitAck("player-stand"); }
  catch (error) { showToast(error.message, true); }
});

els.nextRoundButton.addEventListener("click", async () => {
  try { await emitAck("next-round"); }
  catch (error) { showToast(error.message, true); }
});

els.leaveRoomButton.addEventListener("click", async () => {
  try {
    await emitAck("leave-room");
    showLobby();
  } catch (error) { showToast(error.message, true); }
});

els.copyCodeButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentRoom?.code || "");
    showToast("방 코드를 복사했습니다.");
  } catch (_error) {
    showToast(`방 코드: ${currentRoom?.code || ""}`);
  }
});

els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  try {
    await emitAck("chat-message", { text });
    els.chatInput.value = "";
  } catch (error) { showToast(error.message, true); }
});

els.rankingButton.addEventListener("click", showRanking);
els.historyButton.addEventListener("click", showHistory);
els.logoutButton.addEventListener("click", logout);
els.logoButton.addEventListener("click", () => {
  if (!currentRoom) showLobby();
  else showToast("방을 나간 뒤 로비로 이동할 수 있습니다.");
});
els.modalClose.addEventListener("click", closeModal);
els.modal.addEventListener("click", (event) => { if (event.target === els.modal) closeModal(); });

document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

(async function initialize() {
  if (!token) return;
  try {
    await enterApp();
  } catch (_error) {
    logout();
  }
})();
