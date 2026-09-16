const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { getDB } = require("./db");

function createToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function verifyToken(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });

    const payload = verifyToken(token);
    const db = getDB();
    const user = await db.collection("users").findOne(
      { _id: new ObjectId(payload.userId) },
      { projection: { passwordHash: 0 } }
    );

    if (!user) return res.status(401).json({ error: "사용자를 찾을 수 없습니다." });
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ error: "로그인 정보가 만료되었거나 올바르지 않습니다." });
  }
}

module.exports = { createToken, verifyToken, authMiddleware };
