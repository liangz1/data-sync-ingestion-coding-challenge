# mock-api/Dockerfile
FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，利用缓存
COPY package.json package-lock.json* ./

# 更可复现：优先用 npm ci（如果没有 lockfile 就退化为 npm install）
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# 拷贝源码
COPY . .

# 端口（与你的 server.js 里 PORT 默认一致）
EXPOSE 8787

# 监听在 0.0.0.0（你 server.js 里要 app.listen(PORT, "0.0.0.0")）
ENV PORT=8787
CMD ["node", "server.js"]
