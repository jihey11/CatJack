const { randomUUID } = require("crypto");
const { getDB } = require("../db");
const { roomExpiresAt, roomNotExpiredFilter } = require("../roomLifecycle");

const ROOM_COLLECTION = "rooms";
const ROOM_LOCK_TTL_MS = 60000;
const ROOM_LOCK_WAIT_MS = 70;
const ROOM_LOCK_MAX_ATTEMPTS = 180;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadRoom(code) {
  const db = getDB();
  const room = await db.collection(ROOM_COLLECTION).findOne({
    $and: [{ code }, roomNotExpiredFilter()]
  });
  if (!room) return null;
  delete room._id;
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
        _lock: { owner, expiresAt: new Date(Date.now() + ROOM_LOCK_TTL_MS) },
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

    if (attempt === 0 || attempt % 15 === 0) {
      const db = getDB();
      const exists = await db.collection(ROOM_COLLECTION).findOne(
        { $and: [{ code }, roomNotExpiredFilter()] },
        { projection: { _id: 1 } }
      );
      if (!exists) throw new Error("방을 찾을 수 없습니다.");
    }

    await sleep(ROOM_LOCK_WAIT_MS + Math.floor(Math.random() * 30));
  }

  throw new Error("방 상태를 동기화하는 중입니다. 잠시 후 다시 시도하세요.");
}

// 플레이어와 관전자 모두 같은 사용자가 동시에 여러 방에 들어가지 않도록 조회합니다.
async function findUserRoom(userId) {
  const db = getDB();
  const room = await db.collection(ROOM_COLLECTION).findOne(
    {
      $and: [
        {
          $or: [
            { "players.userId": userId },
            { "spectators.userId": userId }
          ]
        },
        roomNotExpiredFilter()
      ]
    },
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
    spectatorsCount: room.spectators?.length || 0,
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

// 로비에는 공개방만 표시합니다. 진행 중이거나 가득 찬 방도 관전이 허용되어 있으면 표시합니다.
async function publicRoomList() {
  const db = getDB();
  const roomDocs = await db.collection(ROOM_COLLECTION)
    .find(
      {
        $and: [
          { $or: [{ privacy: "PUBLIC" }, { privacy: { $exists: false } }] },
          roomNotExpiredFilter()
        ]
      },
      {
        projection: {
          _id: 0,
          code: 1,
          name: 1,
          maxPlayers: 1,
          minBet: 1,
          status: 1,
          allowSpectators: 1,
          playersCount: 1,
          spectatorsCount: 1,
          "players.userId": 1,
          "spectators.userId": 1
        }
      }
    )
    .sort({ updatedAt: -1 })
    .limit(50)
    .toArray();

  return roomDocs
    .map((room) => {
      const players = Number.isFinite(room.playersCount) ? room.playersCount : (room.players?.length || 0);
      const spectators = Number.isFinite(room.spectatorsCount) ? room.spectatorsCount : (room.spectators?.length || 0);
      const allowSpectators = room.allowSpectators !== false;
      const canJoin = room.status === "WAITING" && players < room.maxPlayers;
      const canSpectate = allowSpectators;
      return {
        code: room.code,
        name: room.name,
        players,
        maxPlayers: room.maxPlayers,
        spectators,
        minBet: room.minBet,
        status: room.status || "WAITING",
        allowSpectators,
        canJoin,
        canSpectate
      };
    })
    .filter((room) => room.canJoin || room.canSpectate);
}

module.exports = {
  ROOM_COLLECTION,
  loadRoom,
  withRoomLock,
  findUserRoom,
  saveRoom,
  deleteRoom,
  randomRoomCode,
  publicRoomList
};
