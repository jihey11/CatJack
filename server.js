require("dotenv").config();

const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const { closeDB } = require("./src/db");
const { publicUser } = require("./src/users/userView");
const { registerAuthRoutes } = require("./src/routes/authRoutes");
const { registerChipRewardRoutes } = require("./src/routes/chipRewardRoutes");
const { registerGameDataRoutes } = require("./src/routes/gameDataRoutes");
const { registerRealtime } = require("./src/socket/realtime");
const { createStartupManager } = require("./src/server/startup");

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET가 환경 변수에 설정되어 있지 않습니다.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Vercel에서 polling 요청이 여러 인스턴스로 분산되는 문제를 피하기 위해
  // WebSocket 연결을 바로 사용합니다.
  transports: ["websocket"],
  allowUpgrades: false,
  pingInterval: 25000,
  pingTimeout: 20000,
  perMessageDeflate: false
});
const PORT = Number(process.env.PORT || 3000);
const { ensureStarted } = createStartupManager(io);

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API가 DB를 사용하기 전에 연결만 보장합니다.
// 인덱스 생성과 정리는 startup.js에서 백그라운드로 실행됩니다.
app.use(async (_req, res, next) => {
  try {
    await ensureStarted();
    next();
  } catch (error) {
    console.error("서버 초기화 실패:", error);
    res.status(503).json({ error: "서버 초기화에 실패했습니다." });
  }
});

registerAuthRoutes(app);
registerChipRewardRoutes(app);
registerGameDataRoutes(app);
registerRealtime(io, { ensureStarted, publicUser });

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
