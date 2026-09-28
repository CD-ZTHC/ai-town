# AI Town —— 依赖很少（hono、zod），只需 Node 运行时
FROM node:26-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUBLIC_MODE=1
WORKDIR /app
# 可选依赖 AI SDK（约 22MB）默认一起安装：anthropic / google / aisdk 类型的模型服务需要它。
# 只用 OpenAI 兼容接口、想要更小的镜像时：docker compose build --build-arg WITH_AISDK=0
ARG WITH_AISDK=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev $([ "$WITH_AISDK" = "1" ] || echo --omit=optional) --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY public ./public
COPY spec ./spec
COPY worlds ./worlds
COPY plugin-host ./plugin-host
COPY plugins/builtin ./plugins/builtin
COPY evolution ./evolution
COPY core.lock ./
# data/：账号、设置、各个世界的存档与 AI 插件（data/worlds/<id>/plugins/，进化引擎只能写开启进化的世界各自的目录）
RUN mkdir -p /app/data /app/plugins/evolved && chown -R node:node /app/data /app/plugins/evolved
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/main.ts"]
