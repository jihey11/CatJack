const { createAdapter } = require("@socket.io/mongo-adapter");
const { connectDB, ensureDatabaseSetup } = require("../db");

function createStartupManager(io) {
  let startupPromise;
  let databaseSetupScheduled = false;

  function scheduleDatabaseSetup() {
    if (databaseSetupScheduled) return;
    databaseSetupScheduled = true;

    // 인덱스 생성/오래된 데이터 정리는 첫 화면과 방 생성 응답을 막지 않습니다.
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

  return { ensureStarted };
}

module.exports = { createStartupManager };
