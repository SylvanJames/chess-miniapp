# 基础镜像：轻量 Node 环境
FROM node:20-alpine

# 工作目录
WORKDIR /app

# 先复制依赖清单（本项目零依赖，但保留规范）
COPY package.json ./

# 复制源码
COPY server.js ./
COPY public ./public

# 环境变量：端口由平台注入
ENV PORT=8080
EXPOSE 8080

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 启动
CMD ["node", "server.js"]
