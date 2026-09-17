const DAILY_REWARD_CHIPS = 300;
const DAILY_REWARD_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const RECOVERY_THRESHOLD_CHIPS = 50;
const RECOVERY_TARGET_CHIPS = 500;
const RECOVERY_COOLDOWN_MS = 12 * 60 * 60 * 1000;

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function nextAvailableAt(lastClaimedAt, cooldownMs) {
  const last = asDate(lastClaimedAt);
  return last ? new Date(last.getTime() + cooldownMs) : null;
}

function buildChipRewardStatus(user, now = new Date()) {
  const rewards = user?.rewards || {};
  const dailyNextAt = nextAvailableAt(rewards.dailyClaimedAt, DAILY_REWARD_COOLDOWN_MS);
  const recoveryNextAt = nextAvailableAt(rewards.recoveryClaimedAt, RECOVERY_COOLDOWN_MS);
  const chips = Number(user?.chips) || 0;

  return {
    chips,
    daily: {
      amount: DAILY_REWARD_CHIPS,
      cooldownMs: DAILY_REWARD_COOLDOWN_MS,
      lastClaimedAt: asDate(rewards.dailyClaimedAt),
      nextAvailableAt: dailyNextAt,
      available: !dailyNextAt || dailyNextAt <= now
    },
    recovery: {
      threshold: RECOVERY_THRESHOLD_CHIPS,
      target: RECOVERY_TARGET_CHIPS,
      cooldownMs: RECOVERY_COOLDOWN_MS,
      lastClaimedAt: asDate(rewards.recoveryClaimedAt),
      nextAvailableAt: recoveryNextAt,
      lowEnough: chips < RECOVERY_THRESHOLD_CHIPS,
      cooldownReady: !recoveryNextAt || recoveryNextAt <= now,
      available: chips < RECOVERY_THRESHOLD_CHIPS && (!recoveryNextAt || recoveryNextAt <= now)
    }
  };
}

module.exports = {
  DAILY_REWARD_CHIPS,
  DAILY_REWARD_COOLDOWN_MS,
  RECOVERY_THRESHOLD_CHIPS,
  RECOVERY_TARGET_CHIPS,
  RECOVERY_COOLDOWN_MS,
  buildChipRewardStatus
};
