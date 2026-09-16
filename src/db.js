const { MongoClient } = require("mongodb");

let client;
let database;

async function connectDB() {
  if (database) return database;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI가 .env에 설정되어 있지 않습니다.");
  }

  client = new MongoClient(uri);
  await client.connect();
  database = client.db();

  await database.collection("users").createIndex({ username: 1 }, { unique: true });
  await database.collection("users").createIndex({ nickname: 1 }, { unique: true });
  await database.collection("games").createIndex({ createdAt: -1 });
  await database.collection("rooms").createIndex({ code: 1 }, { unique: true });
  await database.collection("rooms").createIndex({ "players.userId": 1 });
  await database.collection("rooms").createIndex({ status: 1, updatedAt: -1 });

  return database;
}

function getDB() {
  if (!database) throw new Error("MongoDB가 아직 연결되지 않았습니다.");
  return database;
}

async function closeDB() {
  if (client) await client.close();
}

module.exports = { connectDB, getDB, closeDB };
