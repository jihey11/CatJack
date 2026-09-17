const { getDB } = require("../db");
const { authMiddleware } = require("../auth");
const { findUserRoom } = require("../rooms/roomStore");
const { publicUser } = require("../users/userView");
const {
  DAILY_REWARD_CHIPS,
  DAILY_REWARD_COOLDOWN_MS,
  RECOVERY_THRESHOLD_CHIPS,
  RECOVERY_TARGET_CHIPS,
  RECOVERY_COOLDOWN_MS,
  buildChipRewardStatus
} = require("../chipRewards");

function registerChipRewardRoutes(app) {
  app.get("/api/chip-rewards", authMiddleware, (req, res) => {
    res.json({ rewards: buildChipRewardStatus(req.user) });
  });

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

      return res.json({
        message: `일일 보상으로 ${DAILY_REWARD_CHIPS} CHIP을 받았습니다.`,
        user: publicUser(user),
        rewards: buildChipRewardStatus(user, now)
      });
    } catch (error) {
      console.error("일일 CHIP 보상 오류:", error);
      return res.status(500).json({ error: "일일 CHIP 보상을 처리하지 못했습니다." });
    }
  });

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

      return res.json({
        message: `긴급 복구로 보유 CHIP이 ${RECOVERY_TARGET_CHIPS}이 되었습니다.`,
        user: publicUser(user),
        rewards: buildChipRewardStatus(user, now)
      });
    } catch (error) {
      console.error("긴급 CHIP 복구 오류:", error);
      return res.status(500).json({ error: "긴급 CHIP 복구를 처리하지 못했습니다." });
    }
  });
}

module.exports = { registerChipRewardRoutes };
