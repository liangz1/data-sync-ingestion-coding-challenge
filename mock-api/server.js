import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8787;

// 模拟：GET /api/v1/events?limit=...&cursor=...
app.get("/api/v1/events", (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  const cursor = req.query.cursor ? Number(req.query.cursor) : 0;

  const data = Array.from({ length: limit }, (_, i) => {
    const id = cursor + i + 1;
    return { id: String(id), ts: new Date().toISOString(), type: "mock" };
  });

  const nextCursor = String(cursor + limit);
  const hasMore = cursor + limit < 3000000;

  // 你也可以在这里加 rate limit header 来测试你的处理逻辑
  res.set("X-RateLimit-Limit", "100");
  res.set("X-RateLimit-Remaining", "99");

  res.json({ data, hasMore, nextCursor });
});

// 可选：健康检查
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mock API listening on http://localhost:${PORT}`);
});
