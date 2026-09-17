// 방이 마지막으로 갱신된 뒤 이 시간 동안 아무 활동이 없으면 오래된 방으로 처리합니다.
// 24시간 동안 상태 변화가 없는 방은 MongoDB TTL 인덱스가 자동으로 삭제합니다.
const ROOM_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

function roomExpiresAt(baseTime = Date.now()) {
  const time = baseTime instanceof Date ? baseTime.getTime() : Number(baseTime);
  return new Date((Number.isFinite(time) ? time : Date.now()) + ROOM_IDLE_TTL_MS);
}

// TTL 삭제는 MongoDB 내부에서 약간의 지연이 생길 수 있으므로,
// 애플리케이션에서는 만료 시간이 지난 방을 즉시 없는 방처럼 취급합니다.
function roomNotExpiredFilter(now = new Date()) {
  return {
    $or: [
      { expiresAt: { $gt: now } },
      { expiresAt: { $exists: false } }
    ]
  };
}

async function setupRoomLifecycle(database) {
  const rooms = database.collection("rooms");
  const now = new Date();
  const staleBefore = new Date(now.getTime() - ROOM_IDLE_TTL_MS);

  // 예전 버전에서 expiresAt 없이 남은 방 중 24시간 이상 갱신되지 않은 데이터는
  // 서버 시작 시 먼저 제거합니다.
  const removed = await rooms.deleteMany({
    $or: [
      // expiresAt이 이미 지난 방은 TTL 스캔을 기다리지 않고 바로 정리합니다.
      { expiresAt: { $lte: now } },
      {
        $and: [
          { expiresAt: { $exists: false } },
          {
            $or: [
              { updatedAt: { $lt: staleBefore } },
              { updatedAt: { $exists: false } }
            ]
          }
        ]
      }
    ]
  });

  // 아직 유효한 기존 방에는 TTL 필드를 넣어 이후부터 자동 정리되도록 합니다.
  await rooms.updateMany(
    { expiresAt: { $exists: false } },
    { $set: { expiresAt: roomExpiresAt(now) } }
  );

  // expireAfterSeconds: 0은 문서마다 저장된 expiresAt 시각을 기준으로 삭제합니다.
  await rooms.createIndex(
    { expiresAt: 1 },
    { expireAfterSeconds: 0, name: "rooms_expire_at" }
  );

  if (removed.deletedCount > 0) {
    console.log(`오래된 게임방 ${removed.deletedCount}개를 정리했습니다.`);
  }
}

module.exports = {
  ROOM_IDLE_TTL_MS,
  roomExpiresAt,
  roomNotExpiredFilter,
  setupRoomLifecycle
};
