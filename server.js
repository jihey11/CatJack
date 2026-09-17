require("dotenv").config();

const http = require("http");
const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/mongo-adapter");
const { connectDB, ensureDatabaseSetup, getDB, closeDB } = require("./src/db");
const { createToken, verifyToken, authMiddleware } = require("./src/auth");
const { roomExpiresAt, roomNotExpiredFilter } = require("./src/roomLifecycle");
const {
  DAILY_REWARD_CHIPS,
  DAILY_REWARD_COOLDOWN_MS,
  RECOVERY_THRESHOLD_CHIPS,
  RECOVERY_TARGET_CHIPS,
  RECOVERY_COOLDOWN_MS,
  buildChipRewardStatus
} = require("./src/chipRewards");

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
let databaseSetupScheduled = false;

function scheduleDatabaseSetup() {
  if (databaseSetupScheduled) return;
  databaseSetupScheduled = true;

  // 인덱스 생성/오래된 데이터 정리는 첫 화면과 방 생성 응답을 막지 않습니다.
  // Vercel의 콜드 스타트에서는 DB 연결만 먼저 끝낸 뒤 유지보수 작업을 뒤에서 실행합니다.
  const timer = setTimeout(() => {
    ensureDatabaseSetup().catch((error) => {
      databaseSetupScheduled = false;
      console.error("DB 백그라운드 초기화 실패:", error);
    });
  }, 1500);
  if (typeof timer.unref === "function") timer.unref();
}

async function ensureStarted() {
  if (!startupPromise) {
    startupPromise = (async () => {
      const db = await connectDB();
      const events = db.collection("socket_io_events");

      // Mongo Adapter는 컬렉션만 있으면 바로 사용할 수 있습니다.
      // TTL 인덱스 생성은 scheduleDatabaseSetup()에서 비동기로 처리합니다.
      io.adapter(createAdapter(events, { addCreatedAtField: true }));
      scheduleDatabaseSetup();
      return db;
    })().catch((error) => {
      startupPromise = null;
      throw error;
    });
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


// CHIP 보상 상태 조회
app.get("/api/chip-rewards", authMiddleware, (req, res) => {
  res.json({ rewards: buildChipRewardStatus(req.user) });
});

// 일일 CHIP 보상: 24시간마다 +300 CHIP
app.post("/api/chip-rewards/daily", authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id.toString();
    if (await findUserRoom(userId)) {
      return res.status(409).json({ error: "게임방을 나간 뒤 CHIP 보상을 받을 수 있습니다." });
    }

    const db = getDB();
    const now = new Date();
    const cutoff = new Date(now.getTime() - DAILY_REWARD_COOLDOWN_MS);
    const result = await db.collection("users").updateOne(
      {
        _id: req.user._id,
        $or: [
          { "rewards.dailyClaimedAt": { $exists: false } },
          { "rewards.dailyClaimedAt": { $lte: cutoff } }
        ]
      },
      {
        $inc: { chips: DAILY_REWARD_CHIPS },
        $set: { "rewards.dailyClaimedAt": now }
      }
    );

    const user = await db.collection("users").findOne(
      { _id: req.user._id },
      { projection: { passwordHash: 0 } }
    );

    if (!result.matchedCount) {
      return res.status(409).json({
        error: "아직 일일 보상 시간이 되지 않았습니다.",
        user: publicUser(user),
        rewards: buildChipRewardStatus(user, now)
      });
    }

    res.json({
      message: `일일 보상으로 ${DAILY_REWARD_CHIPS} CHIP을 받았습니다.`,
      user: publicUser(user),
      rewards: buildChipRewardStatus(user, now)
    });
  } catch (error) {
    console.error("일일 CHIP 보상 오류:", error);
    res.status(500).json({ error: "일일 CHIP 보상을 처리하지 못했습니다." });
  }
});

// 긴급 복구: CHIP이 50 미만이면 500 CHIP까지 복구, 12시간 쿨타임
app.post("/api/chip-rewards/recovery", authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id.toString();
    if (await findUserRoom(userId)) {
      return res.status(409).json({ error: "게임방을 나간 뒤 긴급 CHIP 복구를 사용할 수 있습니다." });
    }

    const db = getDB();
    const now = new Date();
    const cutoff = new Date(now.getTime() - RECOVERY_COOLDOWN_MS);
    const result = await db.collection("users").updateOne(
      {
        _id: req.user._id,
        chips: { $lt: RECOVERY_THRESHOLD_CHIPS },
        $or: [
          { "rewards.recoveryClaimedAt": { $exists: false } },
          { "rewards.recoveryClaimedAt": { $lte: cutoff } }
        ]
      },
      {
        $set: {
          chips: RECOVERY_TARGET_CHIPS,
          "rewards.recoveryClaimedAt": now
        }
      }
    );

    const user = await db.collection("users").findOne(
      { _id: req.user._id },
      { projection: { passwordHash: 0 } }
    );

    if (!result.matchedCount) {
      const status = buildChipRewardStatus(user, now);
      const error = !status.recovery.lowEnough
        ? `보유 CHIP이 ${RECOVERY_THRESHOLD_CHIPS} 미만일 때 사용할 수 있습니다.`
        : "아직 긴급 복구 대기 시간이 남아 있습니다.";
      return res.status(409).json({ error, user: publicUser(user), rewards: status });
    }

    res.json({
      message: `긴급 복구로 보유 CHIP이 ${RECOVERY_TARGET_CHIPS}이 되었습니다.`,
      user: publicUser(user),
      rewards: buildChipRewardStatus(user, now)
    });
  } catch (error) {
    console.error("긴급 CHIP 복구 오류:", error);
    res.status(500).json({ error: "긴급 CHIP 복구를 처리하지 못했습니다." });
  }
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
      scores: Array.isArray(mine?.scores) ? mine.scores : (mine?.score != null ? [mine.score] : []),
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
const ROOM_LOCK_TTL_MS = 60000;
const ROOM_LOCK_WAIT_MS = 70;
const ROOM_LOCK_MAX_ATTEMPTS = 180;

async function loadRoom(code) {
  const db = getDB();
  const room = await db.collection(ROOM_COLLECTION).findOne({
    $and: [{ code }, roomNotExpiredFilter()]
  });
  if (!room) return null;
  delete room._id;
  // _lock은 MongoDB에서 방 변경을 직렬화하기 위한 내부 필드이므로
  // 게임 상태 객체에는 포함하지 않습니다.
  delete room._lock;
  return room;
}

async function acquireRoomLock(code, owner) {
  const db = getDB();
  const now = new Date();
  const result = await db.collection(ROOM_COLLECTION).updateOne(
    {
      $and: [
        { code },
        roomNotExpiredFilter(now),
        {
          $or: [
            { _lock: { $exists: false } },
            { _lock: null },
            { "_lock.expiresAt": { $lte: now } },
            { "_lock.owner": owner }
          ]
        }
      ]
    },
    {
      $set: {
        _lock: {
          owner,
          expiresAt: new Date(Date.now() + ROOM_LOCK_TTL_MS)
        },
        // 잠금을 획득한 요청이 처리되는 동안 TTL 삭제가 일어나지 않도록
        // 방 만료 시간도 함께 연장합니다.
        expiresAt: roomExpiresAt()
      }
    }
  );
  return result.matchedCount === 1;
}

async function releaseRoomLock(code, owner) {
  const db = getDB();
  await db.collection(ROOM_COLLECTION).updateOne(
    { code, "_lock.owner": owner },
    { $unset: { _lock: "" } }
  );
}

// 같은 방에 대한 READY, 배팅, HIT, 채팅 등의 변경이 동시에 들어오더라도
// MongoDB의 잠금을 먼저 획득한 요청 하나만 상태를 수정하게 합니다.
// 이 잠금은 여러 Node/Vercel 인스턴스 사이에서도 공유됩니다.
async function withRoomLock(code, task) {
  if (!code) throw new Error("방을 찾을 수 없습니다.");

  const owner = randomUUID();
  for (let attempt = 0; attempt < ROOM_LOCK_MAX_ATTEMPTS; attempt += 1) {
    if (await acquireRoomLock(code, owner)) {
      try {
        return await task();
      } finally {
        await releaseRoomLock(code, owner).catch((error) => {
          console.error("방 잠금 해제 실패:", error);
        });
      }
    }

    // 삭제된 방을 잠금 대기로 오인해 오래 기다리지 않도록 주기적으로 확인합니다.
    if (attempt === 0 || attempt % 15 === 0) {
      const db = getDB();
      const exists = await db.collection(ROOM_COLLECTION).findOne(
        { $and: [{ code }, roomNotExpiredFilter()] },
        { projection: { _id: 1 } }
      );
      if (!exists) throw new Error("방을 찾을 수 없습니다.");
    }

    await delay(ROOM_LOCK_WAIT_MS + Math.floor(Math.random() * 30));
  }

  throw new Error("방 상태를 동기화하는 중입니다. 잠시 후 다시 시도하세요.");
}

async function findUserRoom(userId) {
  const db = getDB();
  const room = await db.collection(ROOM_COLLECTION).findOne(
    { $and: [{ "players.userId": userId }, roomNotExpiredFilter()] },
    { projection: { _id: 0, code: 1 } }
  );
  return room?.code || null;
}

async function saveRoom(room) {
  const db = getDB();
  room.revision = (Number(room.revision) || 0) + 1;
  const now = new Date();
  const doc = {
    ...room,
    playersCount: room.players?.length || 0,
    updatedAt: now,
    expiresAt: roomExpiresAt(now)
  };
  delete doc._id;
  delete doc._lock;
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
  const currentTurnUserId = room.turnIndex >= 0 ? room.players[room.turnIndex]?.userId || null : null;
  const currentTurnHandIndex = room.turnIndex >= 0 ? Math.max(0, Number(room.turnHandIndex) || 0) : null;

  return {
    code: room.code,
    revision: Number(room.revision) || 0,
    name: room.name,
    hostId: room.hostId,
    maxPlayers: room.maxPlayers,
    minBet: room.minBet,
    status: room.status,
    currentTurnUserId,
    currentTurnHandIndex,
    dealerCards: visibleDealerCards(room),
    dealerScore: ["DEALER_TURN", "RESULT"].includes(room.status) ? cardScore(room.dealerHand) : null,
    players: room.players.map((p) => {
      const hands = Array.isArray(p.hands) && p.hands.length
        ? p.hands
        : [{
            cards: Array.isArray(p.hand) ? p.hand : [],
            bet: Number(p.bet) || 0,
            state: p.state || "WAITING",
            result: p.result || null,
            chipChange: Number(p.chipChange) || 0,
            doubled: false,
            split: false
          }];
      const activeIndex = currentTurnUserId === p.userId ? currentTurnHandIndex : 0;
      const primary = hands[activeIndex] || hands[0];
      const roundBet = ["PLAYING", "DEALER_TURN", "RESULT"].includes(room.status)
        ? hands.reduce((sum, hand) => sum + (Number(hand.bet) || 0), 0)
        : p.bet;
      return {
        userId: p.userId,
        nickname: p.nickname,
        chips: p.chips,
        bet: roundBet,
        ready: p.ready,
        connected: p.connected,
        cards: primary?.cards?.map(compactCard) || [],
        score: primary?.cards?.length ? cardScore(primary.cards) : null,
        state: primary?.state || p.state,
        result: p.result || null,
        chipChange: p.chipChange || 0,
        currentHandIndex: activeIndex,
        canDouble: room.status === "PLAYING" && currentTurnUserId === p.userId && canDoubleHand(p, primary),
        canSplit: room.status === "PLAYING" && currentTurnUserId === p.userId && canSplitHand(p, primary),
        hands: hands.map((hand, handIndex) => ({
          index: handIndex,
          cards: (hand.cards || []).map(compactCard),
          score: hand.cards?.length ? cardScore(hand.cards) : null,
          bet: Number(hand.bet) || 0,
          state: hand.state || "WAITING",
          result: hand.result || null,
          chipChange: Number(hand.chipChange) || 0,
          doubled: Boolean(hand.doubled),
          split: Boolean(hand.split),
          active: room.status === "PLAYING" && currentTurnUserId === p.userId && currentTurnHandIndex === handIndex
        }))
      };
    }),
    messages: room.messages.slice(-30)
  };
}

async function publicRoomList() {
  const db = getDB();
  const roomDocs = await db.collection(ROOM_COLLECTION)
    .find(
      { $and: [{ status: "WAITING" }, roomNotExpiredFilter()] },
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

function ensurePlayerHands(player) {
  if (!Array.isArray(player.hands) || player.hands.length === 0) {
    player.hands = [{
      cards: Array.isArray(player.hand) ? player.hand : [],
      bet: Number(player.bet) || 0,
      state: player.state || "WAITING",
      result: player.result || null,
      chipChange: Number(player.chipChange) || 0,
      doubled: false,
      split: false
    }];
  }
  return player.hands;
}

function syncLegacyPlayerState(player, preferredHandIndex = 0) {
  const hands = ensurePlayerHands(player);
  const hand = hands[preferredHandIndex] || hands[0];
  player.hand = hand?.cards || [];
  player.state = hand?.state || "WAITING";
}

function activeHand(room, player) {
  const hands = ensurePlayerHands(player);
  const index = Number(room.turnHandIndex) || 0;
  return { hand: hands[index] || null, index };
}

function nextActivePosition(room, fromPlayerIndex = -1, fromHandIndex = -1) {
  for (let playerIndex = 0; playerIndex < room.players.length; playerIndex += 1) {
    const player = room.players[playerIndex];
    const hands = ensurePlayerHands(player);
    for (let handIndex = 0; handIndex < hands.length; handIndex += 1) {
      if (playerIndex < fromPlayerIndex) continue;
      if (playerIndex === fromPlayerIndex && handIndex <= fromHandIndex) continue;
      if (hands[handIndex].state === "ACTIVE") return { playerIndex, handIndex };
    }
  }
  return null;
}

async function advanceTurn(room) {
  if (room.status !== "PLAYING") return;
  const next = nextActivePosition(room, room.turnIndex, Number(room.turnHandIndex) || 0);
  if (next) {
    room.turnIndex = next.playerIndex;
    room.turnHandIndex = next.handIndex;
    syncLegacyPlayerState(room.players[room.turnIndex], room.turnHandIndex);
    await emitRoom(room);
    return;
  }
  room.turnIndex = -1;
  room.turnHandIndex = -1;
  await runDealer(room);
}

function canSplitHand(player, hand) {
  if (!hand || hand.state !== "ACTIVE" || hand.cards?.length !== 2) return false;
  if ((player.hands?.length || 0) !== 1) return false;
  if (hand.doubled) return false;
  return hand.cards[0]?.value === hand.cards[1]?.value && player.chips >= hand.bet;
}

function canDoubleHand(player, hand) {
  if (!hand || hand.state !== "ACTIVE" || hand.cards?.length !== 2) return false;
  if (hand.doubled) return false;
  return player.chips >= hand.bet;
}

function evaluateHandResult(hand, dealerHand) {
  const playerScore = cardScore(hand.cards);
  const dealerScore = cardScore(dealerHand);
  const playerBJ = !hand.split && isBlackjack(hand.cards);
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

function aggregatePlayerResult(handResults, chipChange) {
  if (handResults.length === 1) return handResults[0];
  if (handResults.every((result) => result === handResults[0])) return handResults[0];
  if (chipChange > 0) return "WIN";
  if (chipChange < 0) return "LOSE";
  return "MIXED";
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
  room.turnHandIndex = -1;
  const dealerScore = cardScore(room.dealerHand);
  const playerRecords = [];

  for (const player of room.players) {
    const hands = ensurePlayerHands(player);
    let totalPayout = 0;
    let totalBet = 0;
    let blackjackCount = 0;

    const handRecords = hands.map((hand) => {
      const result = evaluateHandResult(hand, room.dealerHand);
      const payout = payoutFor(result, hand.bet);
      const chipChange = payout - hand.bet;
      hand.result = result;
      hand.chipChange = chipChange;
      hand.state = "FINISHED";
      totalPayout += payout;
      totalBet += hand.bet;
      if (result === "BLACKJACK") blackjackCount += 1;
      return {
        cards: hand.cards.map(compactCard),
        score: cardScore(hand.cards),
        bet: hand.bet,
        result,
        chipChange,
        doubled: Boolean(hand.doubled),
        split: Boolean(hand.split)
      };
    });

    const chipChange = totalPayout - totalBet;
    const result = aggregatePlayerResult(handRecords.map((hand) => hand.result), chipChange);
    player.result = result;
    player.chipChange = chipChange;
    player.state = "FINISHED";
    player.chips += totalPayout;
    syncLegacyPlayerState(player, 0);

    const inc = {
      chips: totalPayout,
      "stats.games": 1
    };
    const update = { $inc: inc };

    if (chipChange > 0) {
      inc["stats.wins"] = 1;
      inc["stats.currentWinStreak"] = 1;
    } else if (chipChange === 0) {
      inc["stats.draws"] = 1;
      update.$set = { "stats.currentWinStreak": 0 };
    } else {
      inc["stats.losses"] = 1;
      update.$set = { "stats.currentWinStreak": 0 };
    }
    if (blackjackCount) inc["stats.blackjacks"] = blackjackCount;

    await db.collection("users").updateOne(
      { _id: new ObjectId(player.userId) },
      update
    );

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
      cards: handRecords[0]?.cards || [],
      score: handRecords[0]?.score ?? null,
      scores: handRecords.map((hand) => hand.score),
      bet: totalBet,
      result,
      chipChange,
      hands: handRecords
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
  room.turnHandIndex = -1;
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
  if (room.players.length < 1) throw new Error("플레이어가 필요합니다.");
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
    room.turnHandIndex = -1;

    for (const player of room.players) {
      const initialCards = [cards[cursor++], cards[cursor++]];
      const initialState = isBlackjack(initialCards) ? "STAND" : "ACTIVE";
      player.hands = [{
        cards: initialCards,
        bet: player.bet,
        state: initialState,
        result: null,
        chipChange: 0,
        doubled: false,
        split: false
      }];
      player.result = null;
      player.chipChange = 0;
      player.hand = initialCards;
      player.state = initialState;
    }

    room.dealerHand = [cards[cursor++], cards[cursor++]];
    const firstTurn = nextActivePosition(room, -1, -1);
    room.turnIndex = firstTurn ? firstTurn.playerIndex : -1;
    room.turnHandIndex = firstTurn ? firstTurn.handIndex : -1;
    if (firstTurn) syncLegacyPlayerState(room.players[firstTurn.playerIndex], firstTurn.handIndex);
    await emitRoom(room);
    await emitRoomList();

    if (!firstTurn) await runDealer(room);
  } catch (error) {
    await refundBets(room);
    room.status = "WAITING";
    room.deckId = null;
    room.dealerHand = [];
    room.turnIndex = -1;
    room.turnHandIndex = -1;
    room.players.forEach((p) => {
      p.hand = [];
      p.hands = [];
      p.state = "WAITING";
      p.ready = false;
      p.result = null;
      p.chipChange = 0;
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

// 사용자가 다른 방으로 이동하려고 할 때 이전 WAITING/RESULT 방 기록이 남아 있으면
// 분산 Socket 상태 조회를 기다리지 않고 DB 기준으로 바로 정리합니다.
// fetchSockets()는 여러 Vercel 인스턴스의 응답을 기다릴 수 있어 방 생성/참가를
// 수 초씩 지연시키는 원인이 될 수 있습니다.
async function findConflictingUserRoom(userId, targetCode = null) {
  const code = await findUserRoom(userId);
  if (!code || code === targetCode) return null;

  const room = await loadRoom(code);
  if (!room) return null;
  const player = room.players.find((p) => p.userId === userId);
  if (!player) return null;

  // 게임이 실제 진행 중일 때만 다른 방 이동을 막습니다.
  if (!["WAITING", "RESULT"].includes(room.status)) return code;

  let previousSocketId = player.socketId || null;
  let removed = false;

  try {
    await withRoomLock(code, async () => {
      const latestRoom = await loadRoom(code);
      if (!latestRoom) return;
      const latestPlayer = latestRoom.players.find((p) => p.userId === userId);
      if (!latestPlayer) return;
      if (!["WAITING", "RESULT"].includes(latestRoom.status)) return;

      previousSocketId = latestPlayer.socketId || previousSocketId;
      await removePlayerFromWaitingRoom(latestRoom, userId);
      removed = true;
    });
  } catch (error) {
    if (!await loadRoom(code)) return null;
    throw error;
  }

  if (removed) {
    // 다른 탭/인스턴스에 남은 이전 연결 종료는 새 방 입장을 막지 않도록 비동기로 처리합니다.
    if (previousSocketId) {
      try {
        io.in(previousSocketId).disconnectSockets(true);
      } catch (error) {
        console.error("이전 소켓 종료 실패:", error);
      }
    }

    emitRoomList().catch((error) => {
      console.error("방 목록 갱신 실패:", error);
    });
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

io.on("connection", (socket) => {
  // 방 목록 조회 때문에 create/join 이벤트 등록 자체가 늦어지지 않도록
  // 연결 직후의 목록 조회는 비동기로 처리합니다.
  publicRoomList()
    .then((rooms) => socket.emit("rooms-list", rooms))
    .catch((error) => console.error("초기 방 목록 조회 실패:", error));

  socket.on("create-room", async (payload = {}, callback = () => {}) => {
    try {
      const db = getDB();

      // 이전 요청에서 방은 생성됐지만 ACK만 늦게/유실된 경우가 있습니다.
      // 이때 새 방을 만들거나 오류를 내지 않고 기존 방으로 바로 복구합니다.
      const existingCode = await findUserRoom(socket.user.id);
      if (existingCode) {
        let previousSocketId = null;
        let existingRoomState = null;

        try {
          await withRoomLock(existingCode, async () => {
            const existingRoom = await loadRoom(existingCode);
            if (!existingRoom) return;

            const player = existingRoom.players.find((p) => p.userId === socket.user.id);
            if (!player) return;

            previousSocketId = player.socketId || null;
            player.socketId = socket.id;
            player.connected = true;
            player.disconnectedAt = null;

            socket.data.roomCode = existingCode;
            socket.join(existingCode);

            await saveRoom(existingRoom);
            existingRoomState = roomState(existingRoom);
          });
        } catch (error) {
          // 조회 직후 TTL 정리 등으로 방이 사라졌다면 정상적으로 새 방 생성을 계속합니다.
          if (await loadRoom(existingCode)) throw error;
        }

        if (existingRoomState) {
          // 현재 소켓에는 어댑터 전체 브로드캐스트를 기다리지 않고 직접 보냅니다.
          socket.emit("room-state", existingRoomState);
          callback({ ok: true, code: existingCode, reused: true });

          // 다른 참가자에게도 재접속 상태를 알리되 ACK는 기다리지 않습니다.
          io.to(existingCode).emit("room-state", existingRoomState);

          if (previousSocketId && previousSocketId !== socket.id) {
            try {
              io.in(previousSocketId).disconnectSockets(true);
            } catch (error) {
              console.error("이전 소켓 종료 실패:", error);
            }
          }

          emitRoomList().catch((error) => {
            console.error("방 목록 갱신 실패:", error);
          });
          return;
        }
      }

      const freshUser = await db.collection("users").findOne({ _id: new ObjectId(socket.user.id) });
      if (!freshUser) throw new Error("사용자를 찾을 수 없습니다.");

      const code = await randomRoomCode();
      const maxPlayers = Math.min(4, Math.max(1, Number(payload.maxPlayers) || 4));
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
        turnHandIndex: -1,
        dealerRunning: false,
        messages: [],
        revision: 0,
        players: [{
          userId: socket.user.id,
          nickname: freshUser.nickname,
          socketId: socket.id,
          connected: true,
          chips: freshUser.chips,
          bet: Math.min(minBet, freshUser.chips),
          ready: false,
          hand: [],
          hands: [],
          state: "WAITING",
          result: null,
          chipChange: 0
        }]
      };

      // 핵심 상태만 먼저 DB에 저장하고 즉시 성공 응답을 보냅니다.
      // 전체 공개 방 목록 재조회/브로드캐스트는 응답 뒤에 비동기로 처리합니다.
      await saveRoom(room);
      socket.data.roomCode = code;
      socket.join(code);

      socket.emit("room-state", roomState(room));
      callback({ ok: true, code });

      emitRoomList().catch((error) => {
        console.error("방 목록 갱신 실패:", error);
      });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("join-room", async (payload = {}, callback = () => {}) => {
    try {
      const code = String(payload.code || "").trim().toUpperCase();
      if (!code) throw new Error("방 코드를 입력하세요.");
      if (!await loadRoom(code)) throw new Error("존재하지 않는 방입니다.");

      const conflictingRoom = await findConflictingUserRoom(socket.user.id, code);
      if (conflictingRoom) throw new Error("이미 다른 방에 참가 중입니다.");

      let rejoined = false;
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room) throw new Error("존재하지 않는 방입니다.");

        const existing = room.players.find((p) => p.userId === socket.user.id);
        if (existing) {
          const previousSocketId = existing.socketId;
          existing.socketId = socket.id;
          existing.connected = true;
          existing.disconnectedAt = null;
          socket.data.roomCode = code;
          socket.join(code);
          await emitRoom(room);
          rejoined = true;

          if (previousSocketId && previousSocketId !== socket.id) {
            io.in(previousSocketId).disconnectSockets(true);
          }
          return;
        }

        if (room.status !== "WAITING") throw new Error("이미 게임이 시작된 방입니다.");
        if (room.players.length >= room.maxPlayers) throw new Error("방이 가득 찼습니다.");

        const db = getDB();
        const freshUser = await db.collection("users").findOne({ _id: new ObjectId(socket.user.id) });
        if (!freshUser) throw new Error("사용자를 찾을 수 없습니다.");

        room.players.push({
          userId: socket.user.id,
          nickname: freshUser.nickname,
          socketId: socket.id,
          connected: true,
          chips: freshUser.chips,
          bet: Math.min(room.minBet, freshUser.chips),
          ready: false,
          hand: [],
          hands: [],
          state: "WAITING",
          result: null,
          chipChange: 0
        });

        socket.data.roomCode = code;
        socket.join(code);
        await emitRoom(room);
      });

      await emitRoomList();
      callback({ ok: true, code, rejoined });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("leave-room", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      if (!code || !await loadRoom(code)) return callback({ ok: true });

      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room) return;
        if (!["WAITING", "RESULT"].includes(room.status)) {
          throw new Error("게임 진행 중에는 방을 나갈 수 없습니다.");
        }
        await removePlayerFromWaitingRoom(room, socket.user.id);
      });

      socket.data.roomCode = null;
      socket.leave(code);
      await emitRoomList();
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("set-bet", async (payload = {}, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room || room.status !== "WAITING") throw new Error("현재 배팅을 변경할 수 없습니다.");
        const player = room.players.find((p) => p.userId === socket.user.id);
        if (!player) throw new Error("방 참가 정보를 찾을 수 없습니다.");
        const bet = normalizeBet(payload.bet);
        if (bet < room.minBet) throw new Error(`최소 ${room.minBet} CHIP부터 배팅할 수 있습니다.`);
        if (bet > player.chips) throw new Error("보유 CHIP보다 많이 배팅할 수 없습니다.");
        player.bet = bet;
        player.ready = false;
        await emitRoom(room);
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("set-ready", async (payload = {}, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room || room.status !== "WAITING") throw new Error("현재 READY를 변경할 수 없습니다.");
        const player = room.players.find((p) => p.userId === socket.user.id);
        if (!player) throw new Error("방 참가 정보를 찾을 수 없습니다.");
        if (player.bet < room.minBet || player.bet > player.chips) throw new Error("배팅 금액을 먼저 확인하세요.");
        player.ready = Boolean(payload.ready);
        await emitRoom(room);
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("start-game", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room) throw new Error("방을 찾을 수 없습니다.");
        if (room.hostId !== socket.user.id) throw new Error("방장만 게임을 시작할 수 있습니다.");
        await startRound(room);
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("player-hit", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room || room.status !== "PLAYING") throw new Error("게임이 진행 중이 아닙니다.");
        const player = room.players[room.turnIndex];
        if (!player || player.userId !== socket.user.id) throw new Error("현재 당신의 차례가 아닙니다.");
        const { hand, index } = activeHand(room, player);
        if (!hand || hand.state !== "ACTIVE") throw new Error("카드를 더 받을 수 없는 상태입니다.");

        const [card] = await drawCards(room.deckId, 1);
        hand.cards.push(card);
        const score = cardScore(hand.cards);
        if (score > 21) hand.state = "BUST";
        else if (score === 21) hand.state = "STAND";
        syncLegacyPlayerState(player, index);

        await emitRoom(room);
        if (hand.state !== "ACTIVE") await advanceTurn(room);
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("player-double", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room || room.status !== "PLAYING") throw new Error("게임이 진행 중이 아닙니다.");
        const player = room.players[room.turnIndex];
        if (!player || player.userId !== socket.user.id) throw new Error("현재 당신의 차례가 아닙니다.");
        const { hand, index } = activeHand(room, player);
        if (!canDoubleHand(player, hand)) throw new Error("현재 핸드에서는 DOUBLE DOWN을 할 수 없습니다.");

        const extraBet = hand.bet;
        const db = getDB();
        const deducted = await db.collection("users").updateOne(
          { _id: new ObjectId(player.userId), chips: { $gte: extraBet } },
          { $inc: { chips: -extraBet } }
        );
        if (deducted.modifiedCount !== 1) throw new Error("DOUBLE DOWN에 필요한 CHIP이 부족합니다.");

        player.chips -= extraBet;
        hand.bet += extraBet;
        hand.doubled = true;
        try {
          const [card] = await drawCards(room.deckId, 1);
          hand.cards.push(card);
          hand.state = cardScore(hand.cards) > 21 ? "BUST" : "STAND";
          syncLegacyPlayerState(player, index);
          await emitRoom(room);
          await advanceTurn(room);
        } catch (error) {
          await db.collection("users").updateOne(
            { _id: new ObjectId(player.userId) },
            { $inc: { chips: extraBet } }
          );
          player.chips += extraBet;
          hand.bet -= extraBet;
          hand.doubled = false;
          throw error;
        }
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("player-split", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room || room.status !== "PLAYING") throw new Error("게임이 진행 중이 아닙니다.");
        const player = room.players[room.turnIndex];
        if (!player || player.userId !== socket.user.id) throw new Error("현재 당신의 차례가 아닙니다.");
        const { hand } = activeHand(room, player);
        if (!canSplitHand(player, hand)) throw new Error("같은 숫자 카드 2장과 추가 배팅 CHIP이 있어야 SPLIT할 수 있습니다.");

        const extraBet = hand.bet;
        const db = getDB();
        const deducted = await db.collection("users").updateOne(
          { _id: new ObjectId(player.userId), chips: { $gte: extraBet } },
          { $inc: { chips: -extraBet } }
        );
        if (deducted.modifiedCount !== 1) throw new Error("SPLIT에 필요한 CHIP이 부족합니다.");

        player.chips -= extraBet;
        try {
          const [firstDraw, secondDraw] = await drawCards(room.deckId, 2);
          const firstCard = hand.cards[0];
          const secondCard = hand.cards[1];
          const splitAces = firstCard.value === "ACE";
          const makeSplitHand = (card, draw) => {
            const cards = [card, draw];
            return {
              cards,
              bet: extraBet,
              state: splitAces || cardScore(cards) === 21 ? "STAND" : "ACTIVE",
              result: null,
              chipChange: 0,
              doubled: false,
              split: true
            };
          };

          player.hands = [
            makeSplitHand(firstCard, firstDraw),
            makeSplitHand(secondCard, secondDraw)
          ];
          room.turnHandIndex = 0;
          syncLegacyPlayerState(player, 0);
          await emitRoom(room);
          if (player.hands[0].state !== "ACTIVE") await advanceTurn(room);
        } catch (error) {
          await db.collection("users").updateOne(
            { _id: new ObjectId(player.userId) },
            { $inc: { chips: extraBet } }
          );
          player.chips += extraBet;
          throw error;
        }
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("player-stand", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room || room.status !== "PLAYING") throw new Error("게임이 진행 중이 아닙니다.");
        const player = room.players[room.turnIndex];
        if (!player || player.userId !== socket.user.id) throw new Error("현재 당신의 차례가 아닙니다.");
        const { hand, index } = activeHand(room, player);
        if (!hand || hand.state !== "ACTIVE") throw new Error("이미 턴 처리가 끝난 상태입니다.");
        hand.state = "STAND";
        syncLegacyPlayerState(player, index);
        await emitRoom(room);
        await advanceTurn(room);
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("next-round", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room || room.status !== "RESULT") throw new Error("다음 게임을 준비할 수 없는 상태입니다.");
        if (room.hostId !== socket.user.id) throw new Error("방장만 다음 게임을 준비할 수 있습니다.");

        await refreshPlayerBalances(room);
        room.status = "WAITING";
        room.deckId = null;
        room.dealerHand = [];
        room.turnIndex = -1;
        room.turnHandIndex = -1;
        room.dealerRunning = false;
        room.players.forEach((p) => {
          p.bet = p.chips >= room.minBet ? room.minBet : 0;
          p.ready = false;
          p.hand = [];
          p.hands = [];
          p.state = "WAITING";
          p.result = null;
          p.chipChange = 0;
        });
        await emitRoom(room);
      });
      await emitRoomList();
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("chat-message", async (payload = {}, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      await withRoomLock(code, async () => {
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
        if (room.messages.length > 30) room.messages = room.messages.slice(-30);
        await emitRoom(room);
      });
      callback({ ok: true });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("disconnect", async () => {
    const code = socket.data.roomCode || await findUserRoom(socket.user.id);
    if (!code || !await loadRoom(code)) return;

    try {
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room) return;
        const player = room.players.find((p) => p.userId === socket.user.id);
        if (!player || player.socketId !== socket.id) return;

        // Vercel의 WebSocket 재연결이나 일시적인 네트워크 끊김을 고려해
        // 즉시 퇴장시키지 않고 짧은 재접속 유예 시간을 둔다.
        player.connected = false;
        player.socketId = null;
        player.disconnectedAt = Date.now();
        await emitRoom(room);
      });
    } catch (error) {
      console.error("연결 종료 상태 저장 실패:", error);
      return;
    }

    setTimeout(async () => {
      try {
        await ensureStarted();
        if (!await loadRoom(code)) return;
        let roomListChanged = false;

        await withRoomLock(code, async () => {
          const latestRoom = await loadRoom(code);
          if (!latestRoom) return;
          const latestPlayer = latestRoom.players.find((p) => p.userId === socket.user.id);
          if (!latestPlayer || latestPlayer.connected || latestPlayer.socketId) return;

          if (["WAITING", "RESULT"].includes(latestRoom.status)) {
            await removePlayerFromWaitingRoom(latestRoom, socket.user.id);
            roomListChanged = true;
            return;
          }

          if (latestRoom.status === "PLAYING") {
            const hands = ensurePlayerHands(latestPlayer);
            const wasCurrent = latestRoom.players[latestRoom.turnIndex]?.userId === socket.user.id;
            let changed = false;
            for (const hand of hands) {
              if (hand.state === "ACTIVE") {
                hand.state = "STAND";
                changed = true;
              }
            }
            if (changed) {
              syncLegacyPlayerState(latestPlayer, Math.max(0, Number(latestRoom.turnHandIndex) || 0));
              await emitRoom(latestRoom);
              if (wasCurrent) await advanceTurn(latestRoom);
            }
          }
        });

        if (roomListChanged) await emitRoomList();
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
