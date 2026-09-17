require("dotenv").config();

const { connectDB, ensureDatabaseSetup, closeDB } = require("../src/db");

(async () => {
  try {
    await connectDB();
    await ensureDatabaseSetup();
    console.log("CatJack MongoDB 인덱스/방 만료 설정이 완료되었습니다.");
  } catch (error) {
    console.error("MongoDB 설정 실패:", error);
    process.exitCode = 1;
  } finally {
    await closeDB().catch(() => {});
  }
})();
