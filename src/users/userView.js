function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function safeNickname(value) {
  return String(value || "").trim().slice(0, 16);
}

function publicUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    nickname: user.nickname,
    chips: user.chips,
    stats: user.stats || {}
  };
}

module.exports = {
  normalizeUsername,
  safeNickname,
  publicUser
};
