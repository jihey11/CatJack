const { getDB } = require("../db");
const { authMiddleware } = require("../auth");
const { publicRoomList } = require("../rooms/roomStore");

function registerGameDataRoutes(app) {
  app.get("/api/history", authMiddleware, async (req, res) => {
    try {
      const db = getDB();
      const userId = req.user._id.toString();
      const games = await db.collection("games")
        .find({ "players.userId": userId })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();

      const history = games.map((game) => {
        const mine = game.players.find((player) => player.userId === userId);
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

      return res.json({ history });
    } catch (error) {
      console.error("게임 기록 조회 실패:", error);
      return res.status(500).json({ error: "게임 기록을 불러오지 못했습니다." });
    }
  });

  app.get("/api/ranking", async (_req, res) => {
    try {
      const db = getDB();
      const users = await db.collection("users")
        .find({}, { projection: { nickname: 1, chips: 1, stats: 1 } })
        .sort({ chips: -1 })
        .limit(30)
        .toArray();

      return res.json({
        ranking: users.map((user, index) => ({
          rank: index + 1,
          nickname: user.nickname,
          chips: user.chips,
          wins: user.stats?.wins || 0,
          blackjacks: user.stats?.blackjacks || 0
        }))
      });
    } catch (error) {
      console.error("랭킹 조회 실패:", error);
      return res.status(500).json({ error: "랭킹을 불러오지 못했습니다." });
    }
  });

  // 로비를 Socket.IO 연결 전에 빠르게 표시하기 위한 HTTP 방 목록 API입니다.
  // 실시간 갱신은 이후 WebSocket의 rooms-list 이벤트가 담당합니다.
  app.get("/api/rooms", authMiddleware, async (_req, res) => {
    try {
      return res.json({ rooms: await publicRoomList() });
    } catch (error) {
      console.error("방 목록 조회 실패:", error);
      return res.status(500).json({ error: "방 목록을 불러오지 못했습니다." });
    }
  });
}

module.exports = { registerGameDataRoutes };
