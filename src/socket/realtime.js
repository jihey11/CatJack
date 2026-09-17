const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const { getDB } = require("../db");
const { verifyToken } = require("../auth");
const {
  normalizeBet,
  cardScore,
  isBlackjack,
  compactCard,
  createDeck,
  drawCards,
  delay
} = require("../game/blackjack");
const {
  loadRoom,
  withRoomLock,
  findUserRoom,
  saveRoom,
  deleteRoom,
  randomRoomCode,
  publicRoomList
} = require("../rooms/roomStore");

const MAX_SPECTATORS = 20;

function registerRealtime(io, { ensureStarted, publicUser }) {
function visibleDealerCards(room) {
  if (["DEALER_TURN", "RESULT"].includes(room.status)) {
    return room.dealerHand.map(compactCard);
  }
  if (room.status === "PLAYING" && room.dealerHand.length) {
    return [compactCard(room.dealerHand[0]), { hidden: true }];
  }
  return [];
}

function ensureSpectators(room) {
  if (!Array.isArray(room.spectators)) room.spectators = [];
  return room.spectators;
}

function isRoomMember(room, userId) {
  return room.players.some((player) => player.userId === userId)
    || ensureSpectators(room).some((spectator) => spectator.userId === userId);
}

function roomMemberRole(room, userId) {
  if (room.players.some((player) => player.userId === userId)) return "PLAYER";
  if (ensureSpectators(room).some((spectator) => spectator.userId === userId)) return "SPECTATOR";
  return null;
}

async function verifyRoomAccess(room, password) {
  if (!room?.passwordHash) return true;
  const value = String(password || "");
  if (!value) throw new Error("이 방은 비밀번호가 필요합니다.");
  const matches = await bcrypt.compare(value, room.passwordHash);
  if (!matches) throw new Error("방 비밀번호가 올바르지 않습니다.");
  return true;
}

function makePlayer(user, socket, room) {
  return {
    userId: user._id.toString(),
    nickname: user.nickname,
    socketId: socket.id,
    connected: true,
    chips: user.chips,
    bet: Math.min(room.minBet, user.chips),
    ready: false,
    hand: [],
    hands: [],
    state: "WAITING",
    result: null,
    chipChange: 0
  };
}

function makeSpectator(user, socket) {
  return {
    userId: user._id.toString(),
    nickname: user.nickname,
    socketId: socket.id,
    connected: true,
    joinedAt: Date.now()
  };
}


function roomState(room) {
  ensureSpectators(room);
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
    privacy: room.privacy || "PUBLIC",
    hasPassword: Boolean(room.passwordHash),
    allowSpectators: room.allowSpectators !== false,
    spectatorCount: room.spectators.length,
    spectators: room.spectators.map((spectator) => ({
      userId: spectator.userId,
      nickname: spectator.nickname,
      connected: spectator.connected !== false
    })),
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
    messages: (room.messages || []).slice(-30)
  };
}


async function emitRoom(room) {
  await saveRoom(room);
  io.to(room.code).emit("room-state", roomState(room));
}

async function emitRoomList() {
  io.emit("rooms-list", await publicRoomList());
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
  if (index < 0) return false;
  room.players.splice(index, 1);

  if (room.players.length === 0) {
    await deleteRoom(room.code);
    io.to(room.code).emit("room-closed", { message: "플레이어가 모두 나가 방이 종료되었습니다." });
    return true;
  }

  if (room.hostId === userId) room.hostId = room.players[0].userId;
  await emitRoom(room);
  return true;
}

async function removeSpectator(room, userId) {
  const spectators = ensureSpectators(room);
  const index = spectators.findIndex((spectator) => spectator.userId === userId);
  if (index < 0) return false;
  spectators.splice(index, 1);
  await emitRoom(room);
  return true;
}

async function findConflictingUserRoom(userId, targetCode = null) {
  const code = await findUserRoom(userId);
  if (!code || code === targetCode) return null;

  const room = await loadRoom(code);
  if (!room) return null;

  const player = room.players.find((p) => p.userId === userId);
  const spectator = ensureSpectators(room).find((item) => item.userId === userId);
  if (!player && !spectator) return null;

  // 관전자는 언제든 다른 방으로 이동할 수 있습니다.
  // 플레이어는 실제 게임 진행 중일 때만 이동을 막습니다.
  if (player && !["WAITING", "RESULT"].includes(room.status)) return code;

  const member = player || spectator;
  let previousSocketId = member?.socketId || null;
  let removed = false;

  try {
    await withRoomLock(code, async () => {
      const latestRoom = await loadRoom(code);
      if (!latestRoom) return;

      const latestPlayer = latestRoom.players.find((p) => p.userId === userId);
      const latestSpectator = ensureSpectators(latestRoom).find((item) => item.userId === userId);

      if (latestPlayer) {
        if (!["WAITING", "RESULT"].includes(latestRoom.status)) return;
        previousSocketId = latestPlayer.socketId || previousSocketId;
        await removePlayerFromWaitingRoom(latestRoom, userId);
        removed = true;
        return;
      }

      if (latestSpectator) {
        previousSocketId = latestSpectator.socketId || previousSocketId;
        await removeSpectator(latestRoom, userId);
        removed = true;
      }
    });
  } catch (error) {
    if (!await loadRoom(code)) return null;
    throw error;
  }

  if (removed) {
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

      // 이전 요청에서 방은 생성됐지만 ACK만 유실됐을 수 있으므로
      // 이미 소속된 방이 있으면 새로 만들지 않고 해당 방으로 복구합니다.
      const existingCode = await findUserRoom(socket.user.id);
      if (existingCode) {
        let previousSocketId = null;
        let existingRoomState = null;
        let existingRole = null;

        try {
          await withRoomLock(existingCode, async () => {
            const existingRoom = await loadRoom(existingCode);
            if (!existingRoom) return;

            const player = existingRoom.players.find((p) => p.userId === socket.user.id);
            const spectator = ensureSpectators(existingRoom).find((item) => item.userId === socket.user.id);
            const member = player || spectator;
            if (!member) return;

            previousSocketId = member.socketId || null;
            member.socketId = socket.id;
            member.connected = true;
            member.disconnectedAt = null;
            existingRole = player ? "PLAYER" : "SPECTATOR";

            socket.data.roomCode = existingCode;
            socket.data.roomRole = existingRole;
            socket.join(existingCode);

            await saveRoom(existingRoom);
            existingRoomState = roomState(existingRoom);
          });
        } catch (error) {
          if (await loadRoom(existingCode)) throw error;
        }

        if (existingRoomState) {
          socket.emit("room-state", existingRoomState);
          callback({ ok: true, code: existingCode, reused: true, role: existingRole });
          io.to(existingCode).emit("room-state", existingRoomState);

          if (previousSocketId && previousSocketId !== socket.id) {
            try {
              io.in(previousSocketId).disconnectSockets(true);
            } catch (error) {
              console.error("이전 소켓 종료 실패:", error);
            }
          }

          emitRoomList().catch((error) => console.error("방 목록 갱신 실패:", error));
          return;
        }
      }

      const freshUser = await db.collection("users").findOne({ _id: new ObjectId(socket.user.id) });
      if (!freshUser) throw new Error("사용자를 찾을 수 없습니다.");

      const code = await randomRoomCode();
      const maxPlayers = Math.min(4, Math.max(1, Number(payload.maxPlayers) || 4));
      const minBet = normalizeBet(payload.minBet || 10);
      const name = String(payload.name || `${socket.user.nickname}의 방`).trim().slice(0, 24) || "고양이 블랙잭 방";
      const privacy = String(payload.privacy || "PUBLIC").toUpperCase() === "PRIVATE" ? "PRIVATE" : "PUBLIC";
      const roomPassword = privacy === "PRIVATE" ? String(payload.password || "").trim() : "";

      if (roomPassword && (roomPassword.length < 4 || roomPassword.length > 12)) {
        throw new Error("친구방 비밀번호는 4~12자로 입력하세요.");
      }

      const passwordHash = roomPassword ? await bcrypt.hash(roomPassword, 8) : null;
      const room = {
        code,
        name,
        hostId: socket.user.id,
        maxPlayers,
        minBet,
        privacy,
        passwordHash,
        allowSpectators: payload.allowSpectators !== false,
        status: "WAITING",
        deckId: null,
        dealerHand: [],
        turnIndex: -1,
        turnHandIndex: -1,
        dealerRunning: false,
        messages: [],
        spectators: [],
        revision: 0,
        players: []
      };
      room.players.push(makePlayer(freshUser, socket, room));

      await saveRoom(room);
      socket.data.roomCode = code;
      socket.data.roomRole = "PLAYER";
      socket.join(code);

      socket.emit("room-state", roomState(room));
      callback({ ok: true, code, role: "PLAYER" });

      emitRoomList().catch((error) => console.error("방 목록 갱신 실패:", error));
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
      if (conflictingRoom) throw new Error("이미 다른 방에서 게임 중입니다.");

      let rejoined = false;
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room) throw new Error("존재하지 않는 방입니다.");
        ensureSpectators(room);

        const existing = room.players.find((p) => p.userId === socket.user.id);
        if (existing) {
          const previousSocketId = existing.socketId;
          existing.socketId = socket.id;
          existing.connected = true;
          existing.disconnectedAt = null;
          socket.data.roomCode = code;
          socket.data.roomRole = "PLAYER";
          socket.join(code);
          await emitRoom(room);
          rejoined = true;

          if (previousSocketId && previousSocketId !== socket.id) {
            io.in(previousSocketId).disconnectSockets(true);
          }
          return;
        }

        const existingSpectatorIndex = room.spectators.findIndex((item) => item.userId === socket.user.id);
        if (room.status !== "WAITING") throw new Error("이미 게임이 시작된 방입니다. 관전으로 참가할 수 있습니다.");
        if (room.players.length >= room.maxPlayers) throw new Error("방이 가득 찼습니다. 관전으로 참가할 수 있습니다.");

        if (existingSpectatorIndex < 0) {
          await verifyRoomAccess(room, payload.password);
        }

        const db = getDB();
        const freshUser = await db.collection("users").findOne({ _id: new ObjectId(socket.user.id) });
        if (!freshUser) throw new Error("사용자를 찾을 수 없습니다.");

        // 같은 방을 관전 중이었다면 플레이어로 전환합니다.
        if (existingSpectatorIndex >= 0) room.spectators.splice(existingSpectatorIndex, 1);
        room.players.push(makePlayer(freshUser, socket, room));

        socket.data.roomCode = code;
        socket.data.roomRole = "PLAYER";
        socket.join(code);
        await emitRoom(room);
      });

      emitRoomList().catch((error) => console.error("방 목록 갱신 실패:", error));
      callback({ ok: true, code, rejoined, role: "PLAYER" });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("spectate-room", async (payload = {}, callback = () => {}) => {
    try {
      const code = String(payload.code || "").trim().toUpperCase();
      if (!code) throw new Error("방 코드를 입력하세요.");
      if (!await loadRoom(code)) throw new Error("존재하지 않는 방입니다.");

      const conflictingRoom = await findConflictingUserRoom(socket.user.id, code);
      if (conflictingRoom) throw new Error("이미 다른 방에서 게임 중입니다.");

      let rejoined = false;
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room) throw new Error("존재하지 않는 방입니다.");
        ensureSpectators(room);

        const existingPlayer = room.players.find((p) => p.userId === socket.user.id);
        if (existingPlayer) {
          const previousSocketId = existingPlayer.socketId;
          existingPlayer.socketId = socket.id;
          existingPlayer.connected = true;
          existingPlayer.disconnectedAt = null;
          socket.data.roomCode = code;
          socket.data.roomRole = "PLAYER";
          socket.join(code);
          await emitRoom(room);
          rejoined = true;

          if (previousSocketId && previousSocketId !== socket.id) {
            io.in(previousSocketId).disconnectSockets(true);
          }
          return;
        }

        if (room.allowSpectators === false) throw new Error("이 방은 관전을 허용하지 않습니다.");

        const existing = room.spectators.find((item) => item.userId === socket.user.id);
        if (existing) {
          const previousSocketId = existing.socketId;
          existing.socketId = socket.id;
          existing.connected = true;
          existing.disconnectedAt = null;
          socket.data.roomCode = code;
          socket.data.roomRole = "SPECTATOR";
          socket.join(code);
          await emitRoom(room);
          rejoined = true;

          if (previousSocketId && previousSocketId !== socket.id) {
            io.in(previousSocketId).disconnectSockets(true);
          }
          return;
        }

        await verifyRoomAccess(room, payload.password);
        if (room.spectators.length >= MAX_SPECTATORS) throw new Error("관전자 정원이 가득 찼습니다.");

        const db = getDB();
        const freshUser = await db.collection("users").findOne({ _id: new ObjectId(socket.user.id) });
        if (!freshUser) throw new Error("사용자를 찾을 수 없습니다.");

        room.spectators.push(makeSpectator(freshUser, socket));
        socket.data.roomCode = code;
        socket.data.roomRole = "SPECTATOR";
        socket.join(code);
        await emitRoom(room);
      });

      emitRoomList().catch((error) => console.error("방 목록 갱신 실패:", error));
      callback({ ok: true, code, rejoined, role: socket.data.roomRole || "SPECTATOR" });
    } catch (error) {
      callback({ ok: false, error: error.message });
    }
  });

  socket.on("leave-room", async (_payload, callback = () => {}) => {
    try {
      const code = socket.data.roomCode || await findUserRoom(socket.user.id);
      if (!code || !await loadRoom(code)) {
        socket.data.roomCode = null;
        socket.data.roomRole = null;
        return callback({ ok: true });
      }

      let roomDeleted = false;
      await withRoomLock(code, async () => {
        const room = await loadRoom(code);
        if (!room) return;

        const spectator = ensureSpectators(room).find((item) => item.userId === socket.user.id);
        if (spectator) {
          await removeSpectator(room, socket.user.id);
          return;
        }

        const player = room.players.find((item) => item.userId === socket.user.id);
        if (!player) return;
        if (!["WAITING", "RESULT"].includes(room.status)) {
          throw new Error("게임 진행 중에는 플레이어로 방을 나갈 수 없습니다.");
        }

        await removePlayerFromWaitingRoom(room, socket.user.id);
        roomDeleted = room.players.length <= 1 && !await loadRoom(code);
      });

      socket.data.roomCode = null;
      socket.data.roomRole = null;
      socket.leave(code);
      emitRoomList().catch((error) => console.error("방 목록 갱신 실패:", error));
      callback({ ok: true, roomDeleted });
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
        if (!isRoomMember(room, socket.user.id)) throw new Error("이 방의 참가자만 채팅할 수 있습니다.");
        const text = String(payload.text || "").trim().slice(0, 200);
        if (!text) throw new Error("메시지를 입력하세요.");
        room.messages.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          userId: socket.user.id,
          nickname: socket.user.nickname,
          role: roomMemberRole(room, socket.user.id),
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
        const spectator = ensureSpectators(room).find((item) => item.userId === socket.user.id);
        const member = player || spectator;
        if (!member || member.socketId !== socket.id) return;

        member.connected = false;
        member.socketId = null;
        member.disconnectedAt = Date.now();
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

          const latestSpectator = ensureSpectators(latestRoom).find((item) => item.userId === socket.user.id);
          if (latestSpectator && !latestSpectator.connected && !latestSpectator.socketId) {
            await removeSpectator(latestRoom, socket.user.id);
            roomListChanged = true;
            return;
          }

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
}

module.exports = { registerRealtime };
