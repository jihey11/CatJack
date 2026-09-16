require("dotenv").config();

const http = require("http");
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/mongo-adapter");
const { connectDB, getDB, closeDB } = require("./src/db");
const { createToken, verifyToken, authMiddleware } = require("./src/auth");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET가 환경 변수에 설정되어 있지 않습니다.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Vercel에서는 Socket.IO의 기본 long-polling(XHR)이 서로 다른 함수 인스턴스로
  // 분산될 수 있어 "xhr poll error"가 발생할 수 있습니다.
  // WebSocket을 바로 사용해 한 연결이 한 인스턴스에 유지되도록 합니다.
  transports: ["websocket"],
  allowUpgrades: false,
  pingInterval: 25000,
  pingTimeout: 20000,
  perMessageDeflate: false
});
const PORT = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "100kb" }));

// Vercel과 로컬 환경 모두에서 public 폴더의 정적 파일을 제공합니다.
app.use(express.static(path.join(__dirname, "public")));

// 사이트 루트(/)로 접속하면 메인 페이지를 반환합니다.
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

let startupPromise;

async function ensureStarted() {
  if (!startupPromise) {
    startupPromise = (async () => {
      const db = await connectDB();
      const events = db.collection("socket_io_events");
      await events.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
      io.adapter(createAdapter(events, { addCreatedAtField: true }));
      return db;
    })();
  }
  return startupPromise;
}

app.use(async (_req, res, next) => {
  try {
    await ensureStarted();
    next();
  } catch (error) {
    console.error("서버 초기화 실패:", error);
    res.status(503).json({ error: "서버 초기화에 실패했습니다." });
  }
});

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function safeNickname(value) {
  return String(value || "").trim().slice(0, 16);
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    nickname: user.nickname,
    chips: user.chips,
    stats: user.stats || {}
  };
}

app.post("/api/auth/signup", async (req, res) => {
  try {
    const db = getDB();
    const username = normalizeUsername(req.body.username);
    const nickname = safeNickname(req.body.nickname);
    const password = String(req.body.password || "");

    if (!/^[a-z0-9_]{4,20}$/.test(username)) {
      return res.status(400).json({ error: "아이디는 영문 소문자, 숫자, _를 사용해 4~20자로 입력하세요." });
    }
    if (nickname.length < 2) {
      return res.status(400).json({ error: "닉네임은 2~16자로 입력하세요." });
    }
    if (password.length < 6 || password.length > 72) {
      return res.status(400).json({ error: "비밀번호는 6~72자로 입력하세요." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      username,
      nickname,
      passwordHash,
      chips: 1000,
      stats: {
        games: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        blackjacks: 0,
        bestWinStreak: 0,
        currentWinStreak: 0
      },
      createdAt: new Date()
    };

    const result = await db.collection("users").insertOne(user);
    user._id = result.insertedId;
    const token = createToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (error) {
    if (error && error.code === 11000) {
      const key = Object.keys(error.keyPattern || {})[0];
      return res.status(409).json({ error: key === "nickname" ? "이미 사용 중인 닉네임입니다." : "이미 사용 중인 아이디입니다." });
    }
    console.error(error);
    res.status(500).json({ error: "회원가입 중 오류가 발생했습니다." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const db = getDB();
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || "");
    const user = await db.collection("users").findOne({ username });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }

    const token = createToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "로그인 중 오류가 발생했습니다." });
  }
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/history", authMiddleware, async (req, res) => {
  const db = getDB();
  const games = await db.collection("games")
    .find({ "players.userId": req.user._id.toString() })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  const history = games.map((game) => {
    const mine = game.players.find((p) => p.userId === req.user._id.toString());
    return {
      id: game._id.toString(),
      roomName: game.roomName,
      result: mine?.result,
      score: mine?.score,
      dealerScore: game.dealerScore,
      bet: mine?.bet,
      chipChange: mine?.chipChange,
      createdAt: game.createdAt
    };
  });

  res.json({ history });
});

app.get("/api/ranking", async (_req, res) => {
  const db = getDB();
  const users = await db.collection("users")
    .find({}, { projection: { nickname: 1, chips: 1, stats: 1 } })
    .sort({ chips: -1 })
    .limit(30)
    .toArray();

  res.json({
    ranking: users.map((u, index) => ({
      rank: index + 1,
      nickname: u.nickname,
      chips: u.chips,
      wins: u.stats?.wins || 0,
      blackjacks: u.stats?.blackjacks || 0
    }))
  });
});

// 로비를 Socket.IO 연결 전에 빠르게 표시하기 위한 HTTP 방 목록 API입니다.
// 실시간 갱신은 이후 WebSocket의 rooms-list 이벤트가 담당합니다.
app.get("/api/rooms", authMiddleware, async (_req, res) => {
  try {
    res.json({ rooms: await publicRoomList() });
  } catch (error) {
    console.error("방 목록 조회 실패:", error);
    res.status(500).json({ error: "방 목록을 불러오지 못했습니다." });
  }
});

const ROOM_COLLECTION = "rooms";

async function loadRoom(code) {
  const db = getDB();
  const room = await db.collection(ROOM_COLLECTION).findOne({ code });
  if (!room) return null;
  delete room._id;
  return room;
}

async function findUserRoom(userId) {
  const db = getDB();
  const room = await db.collection(ROOM_COLLECTION).findOne(
    { "players.userId": userId },
    { projection: { _id: 0, code: 1 } }
  );
  return room?.code || null;
}

async function saveRoom(room) {
  const db = getDB();
  const doc = { ...room, playersCount: room.players?.length || 0, updatedAt: new Date() };
  delete doc._id;
  await db.collection(ROOM_COLLECTION).updateOne(
    { code: room.code },
    { $set: doc },
    { upsert: true }
  );
}

async function deleteRoom(code) {
  const db = getDB();
  await db.collection(ROOM_COLLECTION).deleteOne({ code });
}

async function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const db = getDB();
  for (let tries = 0; tries < 30; tries += 1) {
    const code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    const exists = await db.collection(ROOM_COLLECTION).findOne({ code }, { projection: { _id: 1 } });
    if (!exists) return code;
  }
  throw new Error("방 코드를 생성하지 못했습니다. 다시 시도하세요.");
}

function normalizeBet(value) {
  const bet = Math.floor(Number(value) / 10) * 10;
  return Number.isFinite(bet) ? Math.max(10, bet) : 10;
}

function cardScore(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.value === "ACE") {
      total += 11;
      aces += 1;
    } else if (["KING", "QUEEN", "JACK"].includes(card.value)) {
      total += 10;
    } else {
      total += Number(card.value);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function isBlackjack(cards) {
  return cards.length === 2 && cardScore(cards) === 21;
}

function compactCard(card) {
  return card ? { code: card.code, value: card.value, suit: card.suit } : null;
}

function visibleDealerCards(room) {
  if (["DEALER_TURN", "RESULT"].includes(room.status)) {
    return room.dealerHand.map(compactCard);
  }
  if (room.status === "PLAYING" && room.dealerHand.length) {
    return [compactCard(room.dealerHand[0]), { hidden: true }];
  }
  return [];
}

function roomState(room) {
  return {
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    minBet: room.minBet,
    status: room.status,
    currentTurnUserId: room.turnIndex >= 0 ? room.players[room.turnIndex]?.userId || null : null,
    dealerCards: visibleDealerCards(room),
    dealerScore: ["DEALER_TURN", "RESULT"].includes(room.status) ? cardScore(room.dealerHand) : null,
    players: room.players.map((p) => ({
      userId: p.userId,
      nickname: p.nickname,
      chips: p.chips,
      bet: p.bet,
      ready: p.ready,
      connected: p.connected,
      cards: p.hand.map(compactCard),
      score: p.hand.length ? cardScore(p.hand) : null,
      state: p.state,
      result: p.result || null,
      chipChange: p.chipChange || 0
    })),
    messages: room.messages.slice(-30)
  };
}

async function publicRoomList() {
  const db = getDB();
  const roomDocs = await db.collection(ROOM_COLLECTION)
    .find(
      { status: "WAITING" },
      { projection: { _id: 0, code: 1, name: 1, maxPlayers: 1, minBet: 1, playersCount: 1, "players.userId": 1 } }
    )
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray();

  return roomDocs
    .map((room) => ({
      code: room.code,
      name: room.name,
      players: Number.isFinite(room.playersCount) ? room.playersCount : (room.players?.length || 0),
      maxPlayers: room.maxPlayers,
      minBet: room.minBet
    }))
    .filter((room) => room.players < room.maxPlayers);
}

async function emitRoom(room) {
  await saveRoom(room);
  io.to(room.code).emit("room-state", roomState(room));
}

async function emitRoomList() {
  io.emit("rooms-list", await publicRoomList());
}

async function createDeck() {
  const response = await fetch("https://deckofcardsapi.com/api/deck/new/shuffle/?deck_count=1");
  if (!response.ok) throw new Error("Deck of Cards API 덱 생성 실패");
  const data = await response.json();
  if (!data.success || !data.deck_id) throw new Error("Deck of Cards API 응답 오류");
  return data.deck_id;
}

async function drawCards(deckId, count) {
  const response = await fetch(`https://deckofcardsapi.com/api/deck/${encodeURIComponent(deckId)}/draw/?count=${count}`);
  if (!response.ok) throw new Error("Deck of Cards API 카드 뽑기 실패");
  const data = await response.json();
  if (!data.success || !Array.isArray(data.cards) || data.cards.length !== count) {
    throw new Error("필요한 카드 수를 가져오지 못했습니다.");
  }
  return data.cards.map(compactCard);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshPlayerBalances(room) {
  const db = getDB();
  const ids = room.players.map((p) => new ObjectId(p.userId));
  const users = await db.collection("users")
    .find({ _id: { $in: ids } }, { projection: { chips: 1, nickname: 1 } })
    .toArray();
  const byId = new Map(users.map((u) => [u._id.toString(), u]));

  for (const player of room.players) {
    const user = byId.get(player.userId);
    if (!user) throw new Error(`${player.nickname} 사용자를 찾을 수 없습니다.`);
    player.chips = user.chips;
    player.nickname = user.nickname;
  }
}

async function deductBets(room) {
  const db = getDB();
  const deducted = [];
  try {
    for (const player of room.players) {
      const result = await db.collection("users").updateOne(
        { _id: new ObjectId(player.userId), chips: { $gte: player.bet } },
        { $inc: { chips: -player.bet } }
      );
      if (result.modifiedCount !== 1) {
        throw new Error(`${player.nickname}님의 CHIP이 부족합니다.`);
      }
      deducted.push(player);
      player.chips -= player.bet;
    }
  } catch (error) {
    for (const player of deducted) {
      await db.collection("users").updateOne(
        { _id: new ObjectId(player.userId) },
        { $inc: { chips: player.bet } }
      );
      player.chips += player.bet;
    }
    throw error;
  }
}

async function refundBets(room) {
  const db = getDB();
  for (const player of room.players) {
    await db.collection("users").updateOne(
      { _id: new ObjectId(player.userId) },
      { $inc: { chips: player.bet } }
    );
    player.chips += player.bet;
  }
}

function nextActiveIndex(room, fromIndex) {
  for (let i = fromIndex + 1; i < room.players.length; i += 1) {
    if (room.players[i].state === "ACTIVE") return i;
  }
  return -1;
}

async function advanceTurn(room) {
  if (room.status !== "PLAYING") return;
  const next = nextActiveIndex(room, room.turnIndex);
  if (next >= 0) {
    room.turnIndex = next;
    await emitRoom(room);
    return;
  }
  room.turnIndex = -1;
  await runDealer(room);
}

function evaluateResult(player, dealerHand) {
  const playerScore = cardScore(player.hand);
  const dealerScore = cardScore(dealerHand);
  const playerBJ = isBlackjack(player.hand);
  const dealerBJ = isBlackjack(dealerHand);

  if (playerScore > 21) return "LOSE";
  if (dealerBJ && playerBJ) return "DRAW";
  if (dealerBJ) return "LOSE";
  if (playerBJ) return "BLACKJACK";
  if (dealerScore > 21) return "WIN";
  if (playerScore > dealerScore) return "WIN";
  if (playerScore < dealerScore) return "LOSE";
  return "DRAW";
}

function payoutFor(result, bet) {
  if (result === "BLACKJACK") return bet * 2.5;
  if (result === "WIN") return bet * 2;
  if (result === "DRAW") return bet;
  return 0;
}

async function finishRound(room) {
  const db = getDB();
  room.status = "RESULT";
  room.turnIndex = -1;
  const dealerScore = cardScore(room.dealerHand);
  const playerRecords = [];

  for (const player of room.players) {
    const result = evaluateResult(player, room.dealerHand);
    const payout = payoutFor(result, player.bet);
    const chipChange = payout - player.bet;
    player.result = result;
    player.chipChange = chipChange;
    player.state = "FINISHED";
    player.chips += payout;

    const inc = {
      chips: payout,
      "stats.games": 1
    };
    const update = { $inc: inc };

    if (result === "WIN" || result === "BLACKJACK") {
      inc["stats.wins"] = 1;
      inc["stats.currentWinStreak"] = 1;
      if (result === "BLACKJACK") inc["stats.blackjacks"] = 1;
    } else if (result === "DRAW") {
      inc["stats.draws"] = 1;
      update.$set = { "stats.currentWinStreak": 0 };
    } else {
      inc["stats.losses"] = 1;
      update.$set = { "stats.currentWinStreak": 0 };
    }

    await db.collection("users").updateOne(
      { _id: new ObjectId(player.userId) },
      update
    );

    // 최고 연승은 현재 값을 다시 읽어 안전하게 갱신한다.
    const updated = await db.collection("users").findOne(
      { _id: new ObjectId(player.userId) },
      { projection: { stats: 1 } }
    );
    const current = updated?.stats?.currentWinStreak || 0;
    const best = updated?.stats?.bestWinStreak || 0;
    if (current > best) {
      await db.collection("users").updateOne(
        { _id: new ObjectId(player.userId) },
        { $set: { "stats.bestWinStreak": current } }
      );
    }

    playerRecords.push({
      userId: player.userId,
      nickname: player.nickname,
      cards: player.hand.map(compactCard),
      score: cardScore(player.hand),
      bet: player.bet,
      result,
      chipChange
    });
  }

  await db.collection("games").insertOne({
    roomCode: room.code,
    roomName: room.name,
    dealerCards: room.dealerHand.map(compactCard),
    dealerScore,
    players: playerRecords,
    createdAt: new Date()
  });

  room.dealerRunning = false;
  await emitRoom(room);
  await emitRoomList();
}

async function runDealer(room) {
  if (room.dealerRunning || room.status === "RESULT") return;
  room.dealerRunning = true;
  room.status = "DEALER_TURN";
  room.turnIndex = -1;
  await emitRoom(room);

  try {
    if (!isBlackjack(room.dealerHand)) {
      while (cardScore(room.dealerHand) < 17) {
        await delay(550);
        const [card] = await drawCards(room.deckId, 1);
        room.dealerHand.push(card);
        await emitRoom(room);
      }
    }
    await delay(450);
    await finishRound(room);
  } catch (error) {
    console.error(error);
    room.dealerRunning = false;
    io.to(room.code).emit("game-error", { message: "딜러 진행 중 카드 API 오류가 발생했습니다." });
  }
}

async function startRound(room) {
  if (room.status !== "WAITING") throw new Error("현재 게임을 시작할 수 없습니다.");
  if (room.players.length < 2) throw new Error("최소 2명의 플레이어가 필요합니다.");
  if (room.players.some((p) => !p.ready)) throw new Error("모든 플레이어가 READY 상태여야 합니다.");
  if (room.players.some((p) => p.bet < room.minBet)) throw new Error("최소 배팅 금액을 확인하세요.");

  await refreshPlayerBalances(room);
  for (const player of room.players) {
    if (player.chips < player.bet) throw new Error(`${player.nickname}님의 CHIP이 부족합니다.`);
  }

  const deckId = await createDeck();
  await deductBets(room);

  try {
    const cards = await drawCards(deckId, room.players.length * 2 + 2);
    let cursor = 0;

    room.deckId = deckId;
    room.dealerHand = [];
    room.dealerRunning = false;
    room.status = "PLAYING";

    for (const player of room.players) {
      player.hand = [cards[cursor++], cards[cursor++]];
      player.result = null;
      player.chipChange = 0;
      player.state = isBlackjack(player.hand) ? "STAND" : "ACTIVE";
    }

    room.dealerHand = [cards[cursor++], cards[cursor++]];
    room.turnIndex = nextActiveIndex(room, -1);
    await emitRoom(room);
    await emitRoomList();

    if (room.turnIndex < 0) await runDealer(room);
  } catch (error) {
    await refundBets(room);
    room.status = "WAITING";
    room.deckId = null;
    room.dealerHand = [];
    room.turnIndex = -1;
    room.players.forEach((p) => {
      p.hand = [];
      p.state = "WAITING";
      p.ready = false;
    });
    await emitRoom(room);
    throw error;
  }
}

async function removePlayerFromWaitingRoom(room, userId) {
  const index = room.players.findIndex((p) => p.userId === userId);
  if (index < 0) return;
  room.players.splice(index, 1);

  if (room.players.length === 0) {
    await deleteRoom(room.code);
    return;
  }
  if (room.hostId === userId) room.hostId = room.players[0].userId;
  await emitRoom(room);
}

// Vercel에서 연결이 갑자기 종료되면 MongoDB의 player.connected 값이
// 이전 상태로 남을 수 있습니다. 다른 방에 들어가려는 순간 실제 Socket.IO
// 연결이 살아 있는지 확인하고, 끊긴 WAITING/RESULT 방 기록은 자동 정리합니다.
async function findConflictingUserRoom(userId, targetCode = null) {
  const code = await findUserRoom(userId);
  if (!code || code === targetCode) return null;

  const room = await loadRoom(code);
  if (!room) return null;
  const player = room.players.find((p) => p.userId === userId);
  if (!player) return null;

  let socketAlive = false;
  if (player.socketId) {
    try {
      const sockets = await io.in(player.socketId).fetchSockets();
      socketAlive = sockets.some((connectedSocket) => connectedSocket.id === player.socketId);
    } catch (error) {
      console.error("기존 소켓 상태 확인 실패:", error);
      socketAlive = Boolean(player.connected && player.socketId);
    }
  }

  if (!socketAlive && ["WAITING", "RESULT"].includes(room.status)) {
    await removePlayerFromWaitingRoom(room, userId);
    await emitRoomList();
    return null;
  }

  return code;
}

io.use(async (socket, next) => {
  try {
    await ensureStarted();
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("로그인이 필요합니다."));
    const payload = verifyToken(token);
    const db = getDB();
    const user = await db.collection("users").findOne(
      { _id: new ObjectId(payload.userId) },
      { projection: { passwordHash: 0 } }
    );
    if (!user) return next(new Error("사용자를 찾을 수 없습니다."));
    socket.user = publicUser(user);
    next();
  } catch (_error) {
    next(new Error("로그인 정보가 만료되었습니다."));
  }
});

io.on("connection", async (socket) => {
  socket.emit("rooms-list", await publicRoomList());

  socket.on("create-room", async (payload = {}, callback = () => {}) => {
    try {
      const conflictingRoom = await findConflictingUserRoom(socket.user.id);
      if (conflictingRoom) throw new Error("이미 다른 방에 참가 중입니다.");
      const db = getDB();
      const freshUser = await db.collection("users").findOne({ _id: new ObjectId(socket.user.id) });
      const code = await randomRoomCode();
      const maxPlayers = Math.min(4, Math.max(2, Number(payload.maxPlayers) || 4));
      const minBet = normalizeBet(payload.minBet || 10);
      const name = String(payload.name || `${socket.user.nickname}의 방`).trim().slice(0, 24) || "고양이 블랙잭 방";

      const room = {
        code,
        name,
        hostId: socket.user.id,
        maxPlayers,
        minBet,
        status: "WAITING",
        deckId: null,
        dealerHand: [],
        turnIndex: -1,
        dealerRunning: false,
        messages: [],
        players: [{
          userId: socket.user.id,
          nickname: freshUser.nickname,
          socketId: socket.id,
          connected: true,
          chips: freshUser.chips,
          bet: Math.min(minBet, freshUser.chips),
          ready: false,
          hand: [],
          state: "WAITING",
          result: null,
          chipChange: 0
        }]
      };

      socket.data.roomCode = code;
      socket.join(code);
      await emitRoom(room);
      await emitRoomList();
      callback({ ok: true, code });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("join-room", async (payload = {}, callback = () => {}) => {
    try {
      const code = String(payload.code || "").trim().toUpperCase();
      const room = await loadRoom(code);
      if (!room) throw new Error("존재하지 않는 방입니다.");

      const existing = room.players.find((p) => p.userId === socket.user.id);
      if (existing) {
        const previousSocketId = existing.socketId;
        existing.socketId = socket.id;
        existing.connected = true;
        existing.disconnectedAt = null;
        if (previousSocketId && previousSocketId !== socket.id) {
          io.in(previousSocketId).disconnectSockets(true);
        }
        socket.data.roomCode = code;
        socket.join(code);
        await emitRoom(room);
        return callback({ ok: true, code, rejoined: true });
      }

      const conflictingRoom = await findConflictingUserRoom(socket.user.id, code);
      if (conflictingRoom) throw new Error("이미 다른 방에 참가 중입니다.");
      if (room.status !== "WAITING") throw new Error("이미 게임이 시작된 방입니다.");
      if (room.players.length >= room.maxPlayers) throw new Error("방이 가득 찼습니다.");

      const db = getDB();
      const freshUser = await db.collection("users").findOne({ _id: new ObjectId(socket.user.id) });
      room.players.push({
        userId: socket.user.id,
        nickname: freshUser.nickname,
        socketId: socket.id,
        connected: true,
        chips: freshUser.chips,
        bet: Math.min(room.minBet, freshUser.chips),
        ready: false,
        hand: [],
        state: "WAITING",
        result: null,
        chipChange: 0
      });

      socket.data.roomCode = code;
      socket.join(code);
      await emitRoom(room);
      await emitRoomList();
      callback({ ok: true, code });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("leave-room", async (_payload, callback = () => {}) => {
    const code = socket.data.roomCode || await findUserRoom(socket.user.id);
    const room = code ? await loadRoom(code) : null;
    if (!room) return callback({ ok: true });
    if (!["WAITING", "RESULT"].includes(room.status)) {
      return callback({ ok: false, error: "게임 진행 중에는 방을 나갈 수 없습니다." });
    }

    await removePlayerFromWaitingRoom(room, socket.user.id);
    socket.data.roomCode = null;
    socket.leave(code);
    await emitRoomList();
    callback({ ok: true });
  });

  socket.on("set-bet", async (payload = {}, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      const room = await loadRoom(code);
      if (!room || room.status !== "WAITING") throw new Error("현재 배팅을 변경할 수 없습니다.");
      const player = room.players.find((p) => p.userId === socket.user.id);
      const bet = normalizeBet(payload.bet);
      if (bet < room.minBet) throw new Error(`최소 ${room.minBet} CHIP부터 배팅할 수 있습니다.`);
      if (bet > player.chips) throw new Error("보유 CHIP보다 많이 배팅할 수 없습니다.");
      player.bet = bet;
      player.ready = false;
      await emitRoom(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("set-ready", async (payload = {}, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      const room = await loadRoom(code);
      if (!room || room.status !== "WAITING") throw new Error("현재 READY를 변경할 수 없습니다.");
      const player = room.players.find((p) => p.userId === socket.user.id);
      if (player.bet < room.minBet || player.bet > player.chips) throw new Error("배팅 금액을 먼저 확인하세요.");
      player.ready = Boolean(payload.ready);
      await emitRoom(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("start-game", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      const room = await loadRoom(code);
      if (!room) throw new Error("방을 찾을 수 없습니다.");
      if (room.hostId !== socket.user.id) throw new Error("방장만 게임을 시작할 수 있습니다.");
      await startRound(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("player-hit", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      const room = await loadRoom(code);
      if (!room || room.status !== "PLAYING") throw new Error("게임이 진행 중이 아닙니다.");
      const player = room.players[room.turnIndex];
      if (!player || player.userId !== socket.user.id) throw new Error("현재 당신의 차례가 아닙니다.");
      if (player.state !== "ACTIVE") throw new Error("카드를 더 받을 수 없는 상태입니다.");

      const [card] = await drawCards(room.deckId, 1);
      player.hand.push(card);
      const score = cardScore(player.hand);
      if (score > 21) {
        player.state = "BUST";
        await emitRoom(room);
        await advanceTurn(room);
      } else if (score === 21) {
        player.state = "STAND";
        await emitRoom(room);
        await advanceTurn(room);
      } else {
        await emitRoom(room);
      }
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("player-stand", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      const room = await loadRoom(code);
      if (!room || room.status !== "PLAYING") throw new Error("게임이 진행 중이 아닙니다.");
      const player = room.players[room.turnIndex];
      if (!player || player.userId !== socket.user.id) throw new Error("현재 당신의 차례가 아닙니다.");
      player.state = "STAND";
      await emitRoom(room);
      await advanceTurn(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("next-round", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      const room = await loadRoom(code);
      if (!room || room.status !== "RESULT") throw new Error("다음 게임을 준비할 수 없는 상태입니다.");
      if (room.hostId !== socket.user.id) throw new Error("방장만 다음 게임을 준비할 수 있습니다.");

      await refreshPlayerBalances(room);
      room.status = "WAITING";
      room.deckId = null;
      room.dealerHand = [];
      room.turnIndex = -1;
      room.dealerRunning = false;
      room.players.forEach((p) => {
        p.bet = p.chips >= room.minBet ? room.minBet : 0;
        p.ready = false;
        p.hand = [];
        p.state = "WAITING";
        p.result = null;
        p.chipChange = 0;
      });
      await emitRoom(room);
      await emitRoomList();
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("chat-message", async (payload = {}, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      const room = await loadRoom(code);
      if (!room) throw new Error("방을 찾을 수 없습니다.");
      const text = String(payload.text || "").trim().slice(0, 200);
      if (!text) throw new Error("메시지를 입력하세요.");
      room.messages.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId: socket.user.id,
        nickname: socket.user.nickname,
        text,
        createdAt: Date.now()
      });
      if (room.messages.length > 30) room.messages.shift();
      await emitRoom(room);
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("disconnect", async () => {
    const code = socket.data.roomCode || await findUserRoom(socket.user.id);
    const room = code ? await loadRoom(code) : null;
    if (!room) return;
    const player = room.players.find((p) => p.userId === socket.user.id);
    if (!player || player.socketId !== socket.id) return;

    // Vercel의 WebSocket 재연결이나 일시적인 네트워크 끊김을 고려해
    // 즉시 퇴장시키지 않고 짧은 재접속 유예 시간을 둔다.
    player.connected = false;
    player.socketId = null;
    player.disconnectedAt = Date.now();
    await emitRoom(room);

    setTimeout(async () => {
      try {
        await ensureStarted();
        const latestRoom = await loadRoom(code);
        if (!latestRoom) return;
        const latestPlayer = latestRoom.players.find((p) => p.userId === socket.user.id);
        if (!latestPlayer || latestPlayer.connected || latestPlayer.socketId) return;

        if (["WAITING", "RESULT"].includes(latestRoom.status)) {
          await removePlayerFromWaitingRoom(latestRoom, socket.user.id);
          await emitRoomList();
          return;
        }

        if (latestRoom.status === "PLAYING" && latestPlayer.state === "ACTIVE") {
          latestPlayer.state = "STAND";
          const wasCurrent = latestRoom.players[latestRoom.turnIndex]?.userId === socket.user.id;
          await emitRoom(latestRoom);
          if (wasCurrent) await advanceTurn(latestRoom);
        }
      } catch (error) {
        console.error("연결 종료 처리 실패:", error);
      }
    }, 15000);
  });
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "API 경로를 찾을 수 없습니다." });
  }
  if (process.env.VERCEL) return next();
  return res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function bootLocal() {
  await ensureStarted();
  server.listen(PORT, () => {
    console.log(`CatJack 서버 실행: http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  bootLocal().catch((error) => {
    console.error("서버 시작 실패:", error);
    process.exit(1);
  });

  async function shutdown() {
    await closeDB();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = server;
