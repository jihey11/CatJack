const bcrypt = require("bcryptjs");
const { getDB } = require("../db");
const { createToken, authMiddleware } = require("../auth");
const { normalizeUsername, safeNickname, publicUser } = require("../users/userView");

function registerAuthRoutes(app) {
  app.post("/api/auth/signup", async (req, res) => {
    try {
      const db = getDB();
      const username = normalizeUsername(req.body.username);
      const nickname = safeNickname(req.body.nickname);
      const password = String(req.body.password || "");

      if (!/^[a-z0-9_]{4,20}$/.test(username)) {
        return res.status(400).json({ error: "아이디는 영문 소문자, 숫자, _를 사용해 4~20자로 입력하세요." });
      }
      if (nickname.length < 2) {
        return res.status(400).json({ error: "닉네임은 2~16자로 입력하세요." });
      }
      if (password.length < 6 || password.length > 72) {
        return res.status(400).json({ error: "비밀번호는 6~72자로 입력하세요." });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const user = {
        username,
        nickname,
        passwordHash,
        chips: 1000,
        stats: {
          games: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          blackjacks: 0,
          bestWinStreak: 0,
          currentWinStreak: 0
        },
        createdAt: new Date()
      };

      const result = await db.collection("users").insertOne(user);
      user._id = result.insertedId;
      const token = createToken(user);
      return res.status(201).json({ token, user: publicUser(user) });
    } catch (error) {
      if (error && error.code === 11000) {
        const key = Object.keys(error.keyPattern || {})[0];
        return res.status(409).json({
          error: key === "nickname" ? "이미 사용 중인 닉네임입니다." : "이미 사용 중인 아이디입니다."
        });
      }
      console.error(error);
      return res.status(500).json({ error: "회원가입 중 오류가 발생했습니다." });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const db = getDB();
      const username = normalizeUsername(req.body.username);
      const password = String(req.body.password || "");
      const user = await db.collection("users").findOne({ username });

      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
      }

      const token = createToken(user);
      return res.json({ token, user: publicUser(user) });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: "로그인 중 오류가 발생했습니다." });
    }
  });

  app.get("/api/me", authMiddleware, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });
}

module.exports = { registerAuthRoutes };
