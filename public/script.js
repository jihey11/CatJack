const $ = (selector) => document.querySelector(selector);

const els = {
  authView: $("#authView"), appView: $("#appView"), lobbyView: $("#lobbyView"), roomView: $("#roomView"),
  loginTab: $("#loginTab"), signupTab: $("#signupTab"), loginForm: $("#loginForm"), signupForm: $("#signupForm"),
  loginUsername: $("#loginUsername"), loginPassword: $("#loginPassword"),
  signupUsername: $("#signupUsername"), signupNickname: $("#signupNickname"), signupPassword: $("#signupPassword"),
  headerChips: $("#headerChips"), welcomeNickname: $("#welcomeNickname"), logoutButton: $("#logoutButton"),
  logoButton: $("#logoButton"), mobileMenuButton: $("#mobileMenuButton"), topMenuActions: $("#topMenuActions"),
  tutorialButton: $("#tutorialButton"), chipRewardButton: $("#chipRewardButton"), rankingButton: $("#rankingButton"), historyButton: $("#historyButton"),
  createRoomForm: $("#createRoomForm"), roomName: $("#roomName"), maxPlayers: $("#maxPlayers"), minBet: $("#minBet"),
  roomPrivacy: $("#roomPrivacy"), roomPassword: $("#roomPassword"), roomPasswordLabel: $("#roomPasswordLabel"), allowSpectators: $("#allowSpectators"),
  roomCodeInput: $("#roomCodeInput"), joinRoomPassword: $("#joinRoomPassword"), joinCodeButton: $("#joinCodeButton"), spectateCodeButton: $("#spectateCodeButton"), quickJoinButton: $("#quickJoinButton"), roomList: $("#roomList"),
  roomStatusBadge: $("#roomStatusBadge"), roomPrivacyBadge: $("#roomPrivacyBadge"), roomCodeBadge: $("#roomCodeBadge"), roomTitle: $("#roomTitle"), roomSubtext: $("#roomSubtext"),
  copyCodeButton: $("#copyCodeButton"), leaveRoomButton: $("#leaveRoomButton"), dealerScore: $("#dealerScore"), dealerCats: $("#dealerCats"),
  turnBanner: $("#turnBanner"), playersGrid: $("#playersGrid"), spectatorBar: $("#spectatorBar"), waitingControls: $("#waitingControls"), playingControls: $("#playingControls"),
  resultControls: $("#resultControls"), betInput: $("#betInput"), setBetButton: $("#setBetButton"), readyButton: $("#readyButton"),
  startButton: $("#startButton"), hitButton: $("#hitButton"), standButton: $("#standButton"), doubleButton: $("#doubleButton"), splitButton: $("#splitButton"), resultSummary: $("#resultSummary"),
  nextRoundButton: $("#nextRoundButton"), chatMessages: $("#chatMessages"), chatForm: $("#chatForm"), chatInput: $("#chatInput"),
  modal: $("#modal"), modalTitle: $("#modalTitle"), modalBody: $("#modalBody"), modalClose: $("#modalClose"), toast: $("#toast")
};

// 로그인 정보는 탭마다 따로 보관합니다.
// localStorage를 사용하면 같은 브라우저의 다른 탭/창에서 로그인 계정이 서로 덮어써질 수 있습니다.
localStorage.removeItem("catjack_token");
let token = sessionStorage.getItem("catjack_token") || "";
let currentUser = null;
let socket = null;
let currentRoom = null;
let currentRoomRevision = -1;
let availableRooms = [];
let toastTimer = null;
const pendingSocketEvents = new Map();
const createRoomSubmitButton = els.createRoomForm?.querySelector('button[type="submit"]');

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

function setMobileMenuOpen(open) {
  if (!els.topMenuActions || !els.mobileMenuButton) return;
  const shouldOpen = Boolean(open);
  els.topMenuActions.classList.toggle("open", shouldOpen);
  els.mobileMenuButton.classList.toggle("open", shouldOpen);
  els.mobileMenuButton.setAttribute("aria-expanded", String(shouldOpen));
  els.mobileMenuButton.textContent = shouldOpen ? "✕ 닫기" : "☰ 메뉴";
}

function closeMobileMenu() {
  setMobileMenuOpen(false);
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

function roomStorageKey() {
  return currentUser?.id ? `catjack_room_${currentUser.id}` : "catjack_room";
}

function roomRoleStorageKey() {
  return currentUser?.id ? `catjack_room_role_${currentUser.id}` : "catjack_room_role";
}

function clearStoredRooms() {
  const keys = [];
  for (let i = 0; i < sessionStorage.length; i += 1) {
    const key = sessionStorage.key(i);
    if (key === "catjack_room" || key === "catjack_room_role" || key?.startsWith("catjack_room_") || key?.startsWith("catjack_room_role_")) keys.push(key);
  }
  keys.forEach((key) => sessionStorage.removeItem(key));
}

function showLobby() {
  currentRoom = null;
  currentRoomRevision = -1;
  sessionStorage.removeItem(roomStorageKey());
  sessionStorage.removeItem(roomRoleStorageKey());
  els.roomView.classList.add("hidden");
  els.lobbyView.classList.remove("hidden");
}

function showRoom() {
  els.lobbyView.classList.add("hidden");
  els.roomView.classList.remove("hidden");
}

function saveSession(authData) {
  // 같은 탭에서 다른 계정으로 로그인할 때 이전 계정의 방 정보를 이어받지 않도록 정리합니다.
  clearStoredRooms();
  token = authData.token;
  currentUser = authData.user;
  sessionStorage.setItem("catjack_token", token);
}

function logout() {
  token = "";
  currentUser = null;
  currentRoom = null;
  currentRoomRevision = -1;
  cancelPendingSocketEvents("로그아웃했습니다.");
  sessionStorage.removeItem("catjack_token");
  clearStoredRooms();
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
    const savedRoom = sessionStorage.getItem(roomStorageKey());
    const savedRole = sessionStorage.getItem(roomRoleStorageKey()) || "PLAYER";
    if (savedRoom) {
      const eventName = savedRole === "SPECTATOR" ? "spectate-room" : "join-room";
      socket.emit(eventName, { code: savedRoom }, (result) => {
        if (!result?.ok) {
          sessionStorage.removeItem(roomStorageKey());
          sessionStorage.removeItem(roomRoleStorageKey());
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

  socket.on("disconnect", () => {
    cancelPendingSocketEvents("실시간 연결이 끊겼습니다. 재연결 후 다시 시도해 주세요.");
    setCreateRoomLoading(false);
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
    const incomingRevision = Number(room?.revision) || 0;

    // 재연결/네트워크 지연으로 이전 상태가 늦게 도착한 경우
    // 현재 화면을 과거 상태로 되돌리지 않습니다.
    if (currentRoom?.code === room?.code && incomingRevision < currentRoomRevision) return;
    if (currentRoom?.code !== room?.code) currentRoomRevision = -1;

    currentRoomRevision = incomingRevision;
    currentRoom = room;
    sessionStorage.setItem(roomStorageKey(), room.code);
    const isPlayer = room.players?.some((player) => player.userId === currentUser?.id);
    const isSpectator = room.spectators?.some((spectator) => spectator.userId === currentUser?.id);
    if (isPlayer) sessionStorage.setItem(roomRoleStorageKey(), "PLAYER");
    else if (isSpectator) sessionStorage.setItem(roomRoleStorageKey(), "SPECTATOR");
    showRoom();
    renderRoom();
  });

  socket.on("room-closed", ({ message } = {}) => {
    showLobby();
    showToast(message || "방이 종료되었습니다.", true);
  });

  socket.on("game-error", ({ message }) => showToast(message, true));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("ko-KR", { maximumFractionDigits: 1 });
}

function setCreateRoomLoading(loading) {
  if (!createRoomSubmitButton) return;
  createRoomSubmitButton.disabled = loading;
  createRoomSubmitButton.textContent = loading ? "방 만드는 중..." : "방 만들기";
}

function cancelPendingSocketEvents(message = "실시간 연결이 끊겼습니다. 다시 시도해 주세요.") {
  const pending = [...pendingSocketEvents.values()];
  for (const request of pending) request.cancel(message);
}

function emitAck(event, payload = {}, options = {}) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error("서버와 연결되어 있지 않습니다."));
    if (pendingSocketEvents.has(event)) {
      return reject(new Error("이 요청을 처리 중입니다. 잠시만 기다려 주세요."));
    }

    const timeoutMs = Math.max(3000, Number(options.timeoutMs) || 15000);
    let settled = false;
    let timeoutId = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      pendingSocketEvents.delete(event);
      if (error) reject(error);
      else resolve(result);
    };

    timeoutId = setTimeout(() => {
      finish(new Error("서버 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요."));
    }, timeoutMs);

    pendingSocketEvents.set(event, {
      cancel(message) {
        finish(new Error(message));
      }
    });

    try {
      socket.emit(event, payload, (result) => {
        if (!result?.ok) {
          return finish(new Error(result?.error || "요청에 실패했습니다."));
        }
        finish(null, result);
      });
    } catch (error) {
      finish(error);
    }
  });
}

function renderRoomList() {
  if (!availableRooms.length) {
    els.roomList.innerHTML = `<div class="empty-state">현재 공개방이 없습니다.<br>새 방을 만들어 친구를 초대해 보세요.</div>`;
    return;
  }

  els.roomList.innerHTML = availableRooms.map((room) => {
    const status = statusText(room.status);
    const joinButton = room.canJoin
      ? `<button class="secondary small room-join" data-code="${escapeHtml(room.code)}" type="button">참가</button>`
      : "";
    const spectateButton = room.canSpectate
      ? `<button class="ghost small room-spectate" data-code="${escapeHtml(room.code)}" type="button">관전</button>`
      : "";
    const actionButtons = joinButton || spectateButton
      ? `<div class="room-actions">${joinButton}${spectateButton}</div>`
      : "";

    return `
      <article class="room-item">
        <div>
          <div class="room-list-heading">
            <h4>${escapeHtml(room.name)}</h4>
            <span class="mini-pill">${escapeHtml(status)}</span>
          </div>
          <p>${room.players}/${room.maxPlayers}명 · 관전자 ${room.spectators || 0}명 · 최소 ${formatNumber(room.minBet)} CHIP · 코드 ${escapeHtml(room.code)}</p>
        </div>
        ${actionButtons}
      </article>`;
  }).join("");

  document.querySelectorAll(".room-join").forEach((button) => {
    button.addEventListener("click", () => joinRoom(button.dataset.code));
  });
  document.querySelectorAll(".room-spectate").forEach((button) => {
    button.addEventListener("click", () => spectateRoom(button.dataset.code));
  });
}

async function joinRoom(code, password = "") {
  try {
    const normalized = String(code || "").trim().toUpperCase();
    if (!normalized) throw new Error("방 코드를 입력하세요.");
    await emitAck("join-room", { code: normalized, password: String(password || "") });
  } catch (error) {
    showToast(error.message, true);
  }
}

async function spectateRoom(code, password = "") {
  try {
    const normalized = String(code || "").trim().toUpperCase();
    if (!normalized) throw new Error("방 코드를 입력하세요.");
    await emitAck("spectate-room", { code: normalized, password: String(password || "") });
  } catch (error) {
    showToast(error.message, true);
  }
}

// 카드 API 값과 public/images/cards 안의 고양이 카드 이미지 파일명을 연결한다.
// 이미지 파일명: sp_*, har_*, dia_*, clob_* (A, 2~10, J, Q, K)
const cardSuitPrefixes = {
  SPADES: "sp",
  HEARTS: "har",
  DIAMONDS: "dia",
  CLUBS: "clob"
};

const cardValueFileNames = {
  ACE: "A",
  JACK: "J",
  QUEEN: "Q",
  KING: "K"
};

const cardValueLabels = {
  ACE: "A",
  JACK: "J",
  QUEEN: "Q",
  KING: "K"
};

const cardSuitLabels = {
  SPADES: "스페이드",
  HEARTS: "하트",
  DIAMONDS: "다이아",
  CLUBS: "클로버"
};

function cardImagePath(card) {
  const suitPrefix = cardSuitPrefixes[card?.suit];
  const valueFileName = cardValueFileNames[card?.value] || card?.value;
  if (!suitPrefix || !valueFileName) return "";
  return `/images/cards/${suitPrefix}_${valueFileName}.png`;
}

function catHtml(card, small = false) {
  if (!card || card.hidden) {
    return `
      <div class="cat-token hidden-cat ${small ? "small-cat" : ""}" title="숨겨진 카드" aria-label="숨겨진 카드">
        <div class="cat-card-back" aria-hidden="true">
          <span class="card-back-paw">🐾</span>
          <span class="card-back-logo">CATJACK</span>
        </div>
      </div>`;
  }

  const imagePath = cardImagePath(card);
  const valueLabel = cardValueLabels[card.value] || card.value;
  const suitLabel = cardSuitLabels[card.suit] || card.suit;
  const altText = `${suitLabel} ${valueLabel} 고양이 카드`;

  return `
    <div class="cat-token ${small ? "small-cat" : ""}" title="${escapeHtml(valueLabel)} / ${escapeHtml(suitLabel)}">
      <img
        class="cat-card-image"
        src="${escapeHtml(imagePath)}"
        alt="${escapeHtml(altText)}"
        draggable="false"
      >
    </div>`;
}

function resultLabel(result) {
  return ({ WIN: "WIN", LOSE: "LOSE", DRAW: "DRAW", BLACKJACK: "BLACKJACK!", MIXED: "MIXED" })[result] || "";
}

function resultClass(result) {
  if (["WIN", "BLACKJACK"].includes(result)) return "result-win";
  if (result === "LOSE") return "result-lose";
  if (["DRAW", "MIXED"].includes(result)) return "result-draw";
  return "";
}

function statusText(status) {
  return ({ WAITING: "WAITING", PLAYING: "PLAYING", DEALER_TURN: "DEALER", RESULT: "RESULT" })[status] || status;
}

function roomSubtitle(room) {
  const visibility = room.privacy === "PRIVATE" ? "친구방" : "공개방";
  const spectatorText = room.allowSpectators ? `관전 허용 · 관전자 ${room.spectatorCount || 0}명` : "관전 불가";
  if (room.status === "WAITING") return `${visibility} · 최소 배팅 ${formatNumber(room.minBet)} CHIP · 최대 ${room.maxPlayers}명 · ${spectatorText}`;
  if (room.status === "PLAYING") return `${visibility} · 각자 딜러를 상대로 21에 가까운 점수를 만드세요. · ${spectatorText}`;
  if (room.status === "DEALER_TURN") return `${visibility} · 모든 플레이어의 턴이 끝났습니다. 딜러가 진행합니다. · ${spectatorText}`;
  return `${visibility} · 이번 판 결과가 확정되었습니다. · ${spectatorText}`;
}

function renderRoom() {
  if (!currentRoom || !currentUser) return;
  const room = currentRoom;
  const me = room.players.find((p) => p.userId === currentUser.id);
  const spectator = room.spectators?.find((item) => item.userId === currentUser.id);
  const isSpectator = !me && Boolean(spectator);

  if (!me && !spectator) {
    showLobby();
    return;
  }

  if (me) {
    currentUser.chips = me.chips;
    els.headerChips.textContent = formatNumber(me.chips);
  }

  els.roomStatusBadge.textContent = statusText(room.status);
  if (els.roomPrivacyBadge) {
    els.roomPrivacyBadge.textContent = room.privacy === "PRIVATE"
      ? `PRIVATE${room.hasPassword ? " 🔒" : ""}`
      : "PUBLIC";
  }
  els.roomCodeBadge.textContent = room.code;
  els.roomTitle.textContent = room.name;
  els.roomSubtext.textContent = isSpectator ? `👁 관전 중 · ${roomSubtitle(room)}` : roomSubtitle(room);
  els.dealerScore.textContent = room.dealerScore ?? "?";
  els.dealerCats.innerHTML = room.dealerCards.length
    ? room.dealerCards.map((card) => catHtml(card)).join("")
    : `<div class="empty-state">게임이 시작되면 딜러 고양이가 등장합니다.</div>`;

  renderPlayers(room);
  renderSpectators(room, isSpectator);
  renderTurn(room, me, isSpectator);
  renderControls(room, me, isSpectator);
  renderChat(room);

  const canLeave = isSpectator || ["WAITING", "RESULT"].includes(room.status);
  els.leaveRoomButton.disabled = !canLeave;
  els.leaveRoomButton.textContent = isSpectator ? "관전 나가기" : "방 나가기";
  els.leaveRoomButton.title = canLeave ? "" : "게임 진행 중에는 플레이어로 나갈 수 없습니다.";
}

function renderSpectators(room, isSpectator = false) {
  if (!els.spectatorBar) return;
  const spectators = Array.isArray(room.spectators) ? room.spectators : [];

  if (!room.allowSpectators && spectators.length === 0) {
    els.spectatorBar.classList.add("hidden");
    return;
  }

  const names = spectators.length
    ? spectators.map((spectator) => `${spectator.connected ? "👁" : "○"} ${escapeHtml(spectator.nickname)}${spectator.userId === currentUser.id ? " (나)" : ""}`).join(" · ")
    : "현재 관전자가 없습니다.";

  els.spectatorBar.innerHTML = `
    <div>
      <strong>관전자 ${spectators.length}명</strong>
      <span>${names}</span>
    </div>
    ${isSpectator ? '<span class="mini-pill spectator-pill">SPECTATING</span>' : ""}
  `;
  els.spectatorBar.classList.remove("hidden");
}

function renderPlayers(room) {
  els.playersGrid.innerHTML = room.players.map((player) => {
    const isMe = player.userId === currentUser.id;
    const isCurrent = room.currentTurnUserId === player.userId;
    const hands = Array.isArray(player.hands) && player.hands.length
      ? player.hands
      : [{ cards: player.cards || [], score: player.score, bet: player.bet, state: player.state, result: player.result, chipChange: player.chipChange }];
    const natural = hands.length === 1 && hands[0].cards?.length === 2 && hands[0].score === 21 && !player.result;
    const stateLabel = player.result
      ? `<span class="mini-pill ${resultClass(player.result)}">${resultLabel(player.result)} ${player.chipChange >= 0 ? "+" : ""}${formatNumber(player.chipChange)}</span>`
      : player.ready && room.status === "WAITING"
        ? `<span class="mini-pill ready-pill">READY</span>`
        : natural
          ? `<span class="mini-pill result-win">BLACKJACK</span>`
          : hands.length > 1
            ? `<span class="mini-pill">${hands.length} HANDS</span>`
            : `<span class="mini-pill">${escapeHtml(player.state || "WAITING")}</span>`;

    const handHtml = hands.map((hand, handIndex) => {
      const handResult = hand.result
        ? `<span class="mini-pill ${resultClass(hand.result)}">${resultLabel(hand.result)} ${hand.chipChange >= 0 ? "+" : ""}${formatNumber(hand.chipChange)}</span>`
        : `<span class="mini-pill">${escapeHtml(hand.state || "WAITING")}</span>`;
      const flags = [hand.split ? "SPLIT" : "", hand.doubled ? "DOUBLE" : ""].filter(Boolean).join(" · ");
      return `
        <div class="player-hand ${hand.active ? "active-hand" : ""}">
          <div class="hand-header">
            <div class="hand-label">${hands.length > 1 ? `HAND ${handIndex + 1}` : "HAND"}${flags ? ` · ${flags}` : ""}</div>
            <div class="hand-meta">
              <span>BET ${formatNumber(hand.bet ?? player.bet)}</span>
              <strong>${hand.score ?? "-"}</strong>
              ${handResult}
            </div>
          </div>
          <div class="player-cats">
            ${hand.cards?.length ? hand.cards.map((card) => catHtml(card, true)).join("") : '<span class="empty-state" style="width:100%;padding:18px">아직 고양이가 없습니다.</span>'}
          </div>
        </div>`;
    }).join("");

    return `
      <article class="player-card ${isMe ? "me" : ""} ${isCurrent ? "current" : ""}">
        <div class="player-head">
          <div>
            <div class="player-name">${player.connected ? "🐱" : '<span class="offline-dot">●</span>'} ${escapeHtml(player.nickname)} ${isMe ? "(나)" : ""}</div>
            ${room.status === "WAITING" ? `
              <div class="player-stats">
                <span class="mini-pill">🪙 ${formatNumber(player.chips)}</span>
                <span class="mini-pill">TOTAL BET ${formatNumber(player.bet)}</span>
                ${stateLabel}
              </div>` : ""}
          </div>
        </div>
        <div class="player-hands">${handHtml}</div>
      </article>`;
  }).join("");
}

function renderTurn(room, me, isSpectator = false) {
  els.turnBanner.classList.remove("my-turn");

  if (isSpectator) {
    if (room.status === "WAITING") {
      const ready = room.players.filter((p) => p.ready).length;
      els.turnBanner.textContent = `관전 중 · ${ready}/${room.players.length}명 READY`;
      return;
    }
    if (room.status === "DEALER_TURN") {
      els.turnBanner.textContent = "관전 중 · 딜러가 카드를 뽑는 중입니다...";
      return;
    }
    if (room.status === "RESULT") {
      els.turnBanner.textContent = "관전 중 · 이번 판 결과를 확인하세요.";
      return;
    }

    const current = room.players.find((p) => p.userId === room.currentTurnUserId);
    els.turnBanner.textContent = current ? `관전 중 · ${current.nickname}님의 차례입니다.` : "관전 중";
    return;
  }

  if (room.status === "WAITING") {
    const ready = room.players.filter((p) => p.ready).length;
    els.turnBanner.textContent = room.players.length === 1
      ? `${ready}/1명 READY · 혼자서도 시작할 수 있습니다.`
      : `${ready}/${room.players.length}명 READY`;
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
  const handNumber = (room.currentTurnHandIndex ?? 0) + 1;
  const hasSplitHands = (current?.hands?.length || 0) > 1;
  const handText = hasSplitHands ? ` ${handNumber}번째 핸드` : "";
  if (!current) {
    els.turnBanner.textContent = "다음 턴을 준비 중입니다.";
  } else if (me && current.userId === me.userId) {
    els.turnBanner.textContent = `당신의${handText} 차례입니다! HIT, STAND, DOUBLE, SPLIT 중 선택하세요.`;
    els.turnBanner.classList.add("my-turn");
  } else {
    els.turnBanner.textContent = `${current.nickname}님의${handText} 차례입니다.`;
  }
}

function renderControls(room, me, isSpectator = false) {
  if (isSpectator || !me) {
    els.waitingControls.classList.add("hidden");
    els.playingControls.classList.add("hidden");
    els.resultControls.classList.add("hidden");
    return;
  }

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
    const allReady = room.players.length >= 1 && room.players.every((p) => p.ready);
    els.startButton.disabled = !allReady;
    els.startButton.textContent = room.players.length === 1 ? "혼자 게임 시작" : "게임 시작";
  }

  if (playing) {
    const myTurn = room.status === "PLAYING" && room.currentTurnUserId === currentUser.id && me.state === "ACTIVE";
    els.hitButton.disabled = !myTurn;
    els.standButton.disabled = !myTurn;
    els.doubleButton.disabled = !myTurn || !me.canDouble;
    els.splitButton.disabled = !myTurn || !me.canSplit;
    els.doubleButton.title = me.canDouble ? "현재 배팅과 같은 금액을 추가하고 카드 1장만 받은 뒤 자동 STAND합니다." : "첫 2장일 때 추가 배팅 CHIP이 있어야 사용할 수 있습니다.";
    els.splitButton.title = me.canSplit ? "같은 숫자 카드 2장을 두 핸드로 나눕니다." : "같은 숫자 카드 2장과 추가 배팅 CHIP이 있어야 사용할 수 있습니다.";
  }

  if (result) {
    const hands = Array.isArray(me.hands) ? me.hands : [];
    const sign = me.chipChange > 0 ? "+" : "";
    if (hands.length > 1) {
      const detail = hands.map((hand, index) => `HAND ${index + 1} ${resultLabel(hand.result)} (${hand.chipChange > 0 ? "+" : ""}${formatNumber(hand.chipChange)})`).join(" · ");
      els.resultSummary.innerHTML = `${escapeHtml(detail)}<br><span class="${resultClass(me.result)}">TOTAL ${sign}${formatNumber(me.chipChange)} CHIP</span>`;
    } else {
      const label = resultLabel(me.result);
      els.resultSummary.innerHTML = `<span class="${resultClass(me.result)}">${escapeHtml(label)}</span> · ${sign}${formatNumber(me.chipChange)} CHIP`;
    }
    els.nextRoundButton.classList.toggle("hidden", room.hostId !== currentUser.id);
  }
}

function renderChat(room) {
  const nearBottom = els.chatMessages.scrollHeight - els.chatMessages.scrollTop - els.chatMessages.clientHeight < 80;
  els.chatMessages.innerHTML = room.messages?.length
    ? room.messages.map((message) => {
        const isMine = message.userId === currentUser.id;
        return `
          <div class="chat-message ${isMine ? "mine" : "other"}">
            ${isMine ? "" : `<strong>${escapeHtml(message.nickname)}${message.role === "SPECTATOR" ? ' <em class="chat-role">관전자</em>' : ""}</strong>`}
            <span>${escapeHtml(message.text)}</span>
          </div>`;
      }).join("")
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

function rewardCountdownLabel(nextAvailableAt) {
  if (!nextAvailableAt) return "지금 받을 수 있어요";
  const remaining = new Date(nextAvailableAt).getTime() - Date.now();
  if (remaining <= 0) return "지금 받을 수 있어요";

  const totalMinutes = Math.ceil(remaining / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분 후`;
  return `${minutes}분 후`;
}

function renderChipRewardModal(rewards) {
  const inRoom = Boolean(currentRoom);
  const dailyDisabled = inRoom || !rewards.daily.available;
  const recoveryDisabled = inRoom || !rewards.recovery.available;

  let recoveryState = "";
  if (!rewards.recovery.lowEnough) {
    recoveryState = `보유 CHIP이 ${formatNumber(rewards.recovery.threshold)} 미만일 때 사용 가능`;
  } else if (!rewards.recovery.cooldownReady) {
    recoveryState = rewardCountdownLabel(rewards.recovery.nextAvailableAt);
  } else {
    recoveryState = "지금 복구할 수 있어요";
  }

  openModal("CHIP 보상", `
    <div class="reward-balance">
      <span>현재 보유 CHIP</span>
      <strong>🪙 ${formatNumber(rewards.chips)}</strong>
    </div>
    ${inRoom ? '<div class="reward-notice">게임방을 나간 뒤 보상을 받을 수 있습니다.</div>' : ''}
    <div class="reward-grid">
      <section class="reward-card">
        <div class="reward-icon">🎁</div>
        <div class="reward-copy">
          <span class="reward-kicker">DAILY BONUS</span>
          <h4>일일 보상</h4>
          <strong>+${formatNumber(rewards.daily.amount)} CHIP</strong>
          <p>24시간마다 한 번 받을 수 있습니다.</p>
          <small>${rewardCountdownLabel(rewards.daily.nextAvailableAt)}</small>
        </div>
        <button id="claimDailyReward" class="primary wide" type="button" ${dailyDisabled ? "disabled" : ""}>
          ${rewards.daily.available ? "보상 받기" : "대기 중"}
        </button>
      </section>
      <section class="reward-card">
        <div class="reward-icon">🛟</div>
        <div class="reward-copy">
          <span class="reward-kicker">EMERGENCY</span>
          <h4>긴급 CHIP 복구</h4>
          <strong>${formatNumber(rewards.recovery.target)} CHIP까지 복구</strong>
          <p>${formatNumber(rewards.recovery.threshold)} CHIP 미만일 때, 12시간마다 사용할 수 있습니다.</p>
          <small>${escapeHtml(recoveryState)}</small>
        </div>
        <button id="claimRecoveryReward" class="secondary wide" type="button" ${recoveryDisabled ? "disabled" : ""}>
          ${rewards.recovery.available ? "긴급 복구" : "사용 불가"}
        </button>
      </section>
    </div>
  `);

  $("#claimDailyReward")?.addEventListener("click", () => claimChipReward("daily"));
  $("#claimRecoveryReward")?.addEventListener("click", () => claimChipReward("recovery"));
}


function showTutorial() {
  openModal("CatJack 블랙잭 튜토리얼", `
    <div class="tutorial-guide">
      <section class="tutorial-hero">
        <div class="tutorial-hero-icon">♠</div>
        <div>
          <span class="tutorial-kicker">HOW TO PLAY</span>
          <h4>21에 가깝게, 딜러보다 높게!</h4>
          <p>카드 합이 21을 넘지 않으면서 딜러보다 높은 점수를 만들면 승리합니다.</p>
        </div>
      </section>

      <section class="tutorial-section">
        <h4><span>1</span> 카드 점수</h4>
        <div class="tutorial-score-grid">
          <div><strong>2 ~ 10</strong><small>적힌 숫자 그대로</small></div>
          <div><strong>J · Q · K</strong><small>각각 10점</small></div>
          <div><strong>A</strong><small>1점 또는 11점</small></div>
        </div>
        <p class="tutorial-tip">A는 내 점수가 21을 넘지 않도록 자동으로 1 또는 11로 계산됩니다.</p>
      </section>

      <section class="tutorial-section">
        <h4><span>2</span> 게임 진행</h4>
        <div class="tutorial-flow">
          <div><b>①</b><span>CHIP을 배팅합니다.</span></div>
          <div><b>②</b><span>READY 후 방장이 게임을 시작합니다.</span></div>
          <div><b>③</b><span>각자 카드 2장을 받고 차례대로 행동합니다.</span></div>
          <div><b>④</b><span>모든 플레이가 끝나면 딜러가 카드를 공개합니다.</span></div>
          <div><b>⑤</b><span>딜러와 점수를 비교해 CHIP을 정산합니다.</span></div>
        </div>
      </section>

      <section class="tutorial-section">
        <h4><span>3</span> 내 차례에 할 수 있는 행동</h4>
        <div class="tutorial-actions">
          <article>
            <strong>🐾 HIT</strong>
            <p>카드를 한 장 더 받습니다. 21을 넘으면 즉시 BUST로 패배합니다.</p>
          </article>
          <article>
            <strong>😼 STAND</strong>
            <p>더 이상 카드를 받지 않고 현재 점수로 턴을 종료합니다.</p>
          </article>
          <article>
            <strong>2× DOUBLE</strong>
            <p>첫 2장일 때 배팅을 한 번 더 추가하고 카드 1장만 받은 뒤 자동 STAND합니다.</p>
          </article>
          <article>
            <strong>✂ SPLIT</strong>
            <p>처음 받은 두 카드의 값이 같으면 같은 금액을 추가 배팅해 두 개의 핸드로 나눕니다.</p>
          </article>
        </div>
      </section>

      <section class="tutorial-section">
        <h4><span>4</span> 승패 판정</h4>
        <div class="tutorial-rules">
          <div><strong>21 초과</strong><span>즉시 패배 (BUST)</span></div>
          <div><strong>딜러 21 초과</strong><span>남아 있는 플레이어 승리</span></div>
          <div><strong>내 점수 &gt; 딜러</strong><span>승리</span></div>
          <div><strong>내 점수 = 딜러</strong><span>무승부 · 배팅금 반환</span></div>
        </div>
      </section>

      <section class="tutorial-blackjack">
        <div class="tutorial-blackjack-mark">♛</div>
        <div>
          <strong>BLACKJACK</strong>
          <p>처음 받은 카드 2장으로 21을 만들면 BLACKJACK입니다. CatJack에서는 일반 승리보다 높은 <b>2.5배 지급</b>을 받습니다.</p>
        </div>
      </section>

      <div class="tutorial-note">
        <strong>TIP</strong>
        <span>딜러는 점수가 17 이상이 될 때까지 자동으로 카드를 받습니다.</span>
      </div>
    </div>
  `);
}

async function showChipRewards() {
  try {
    const { rewards } = await api("/api/chip-rewards");
    renderChipRewardModal(rewards);
  } catch (error) {
    showToast(error.message, true);
  }
}

async function claimChipReward(type) {
  const dailyButton = $("#claimDailyReward");
  const recoveryButton = $("#claimRecoveryReward");
  if (dailyButton) dailyButton.disabled = true;
  if (recoveryButton) recoveryButton.disabled = true;

  try {
    const data = await api(`/api/chip-rewards/${type}`, { method: "POST" });
    currentUser = data.user;
    els.headerChips.textContent = formatNumber(currentUser.chips);
    showToast(data.message || "CHIP을 받았습니다.");
    renderChipRewardModal(data.rewards);
  } catch (error) {
    showToast(error.message, true);
    try {
      const { rewards } = await api("/api/chip-rewards");
      renderChipRewardModal(rewards);
    } catch (_refreshError) {
      closeModal();
    }
  }
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
            <td>${Array.isArray(row.scores) && row.scores.length > 1 ? row.scores.join(" / ") : row.score}</td><td>${row.dealerScore}</td>
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
  if (createRoomSubmitButton?.disabled) return;

  setCreateRoomLoading(true);
  try {
    const result = await emitAck("create-room", {
      name: els.roomName.value,
      maxPlayers: Number(els.maxPlayers.value),
      minBet: Number(els.minBet.value),
      privacy: els.roomPrivacy.value,
      password: els.roomPrivacy.value === "PRIVATE" ? els.roomPassword.value : "",
      allowSpectators: Boolean(els.allowSpectators.checked)
    }, { timeoutMs: 10000 });

    if (result?.reused) {
      showToast("이미 만들어진 방으로 다시 연결했습니다.");
    }
  } catch (error) {
    // ACK만 유실됐더라도 room-state를 받았다면 이미 방 생성은 성공한 상태입니다.
    if (!currentRoom) showToast(error.message, true);
  } finally {
    setCreateRoomLoading(false);
  }
});

els.roomPrivacy.addEventListener("change", () => {
  const isPrivate = els.roomPrivacy.value === "PRIVATE";
  els.roomPasswordLabel.classList.toggle("hidden", !isPrivate);
  if (!isPrivate) els.roomPassword.value = "";
});

els.joinCodeButton.addEventListener("click", () => joinRoom(els.roomCodeInput.value, els.joinRoomPassword.value));
els.spectateCodeButton.addEventListener("click", () => spectateRoom(els.roomCodeInput.value, els.joinRoomPassword.value));
els.roomCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom(els.roomCodeInput.value, els.joinRoomPassword.value);
});
els.joinRoomPassword.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom(els.roomCodeInput.value, els.joinRoomPassword.value);
});

els.quickJoinButton.addEventListener("click", () => {
  const room = availableRooms.find((item) => item.canJoin);
  if (!room) return showToast("현재 참가 가능한 공개방이 없습니다.", true);
  joinRoom(room.code);
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

els.doubleButton.addEventListener("click", async () => {
  try { await emitAck("player-double"); }
  catch (error) { showToast(error.message, true); }
});

els.splitButton.addEventListener("click", async () => {
  try { await emitAck("player-split"); }
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

els.mobileMenuButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  setMobileMenuOpen(!els.topMenuActions?.classList.contains("open"));
});

els.topMenuActions?.addEventListener("click", (event) => {
  event.stopPropagation();
  if (event.target.closest("button")) closeMobileMenu();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".top-actions")) closeMobileMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMobileMenu();
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 680) closeMobileMenu();
});

els.tutorialButton.addEventListener("click", showTutorial);
els.chipRewardButton.addEventListener("click", showChipRewards);
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
