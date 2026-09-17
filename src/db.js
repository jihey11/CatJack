const { MongoClient } = require("mongodb");
const { setupRoomLifecycle } = require("./roomLifecycle");

let client;
let database;
let connectPromise;
let setupPromise;

async function connectDB() {
  if (database) return database;
  if (connectPromise) return connectPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI가 .env에 설정되어 있지 않습니다.");
  }

  connectPromise = (async () => {
    const nextClient = new MongoClient(uri, {
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 60000,
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 6000
    });

    await nextClient.connect();
    client = nextClient;
    database = client.db();
    return database;
  })().catch((error) => {
    connectPromise = null;
    throw error;
  });

  return connectPromise;
}

// 인덱스 생성과 기존 오래된 방 정리는 서버의 첫 요청을 막지 않도록
// DB 연결과 분리해서 실행합니다. 이미 만들어진 인덱스는 그대로 재사용됩니다.
async function ensureDatabaseSetup() {
  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    const db = await connectDB();

    await Promise.all([
      db.collection("users").createIndexes([
        { key: { username: 1 }, unique: true },
        { key: { nickname: 1 }, unique: true }
      ]),
      db.collection("games").createIndex({ createdAt: -1 }),
      db.collection("socket_io_events").createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 3600 }
      )
    ]);

    await db.collection("rooms").createIndexes([
      { key: { code: 1 }, unique: true },
      { key: { "players.userId": 1 } },
      { key: { "spectators.userId": 1 } },
      { key: { privacy: 1, status: 1, updatedAt: -1 } }
    ]);

    await setupRoomLifecycle(db);
    return db;
  })().catch((error) => {
    setupPromise = null;
    throw error;
  });

  return setupPromise;
}

function getDB() {
  if (!database) throw new Error("MongoDB가 아직 연결되지 않았습니다.");
  return database;
}

async function closeDB() {
  if (client) await client.close();
  client = null;
  database = null;
  connectPromise = null;
  setupPromise = null;
}

module.exports = { connectDB, ensureDatabaseSetup, getDB, closeDB };
