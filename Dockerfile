# AI Town —— 依赖很少（hono、zod），只需 Node 运行时
FROM node:26-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUBLIC_MODE=1
WORKDIR /app
# WITH_PI=1 时连同可选依赖 pi-ai 一起安装（LLM_PROVIDER=pi 需要）：docker compose build --build-arg WITH_PI=1
ARG WITH_PI=0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev $([ "$WITH_PI" = "1" ] || echo --omit=optional) --no-audit --no-fund && npm cache clean --force
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
CMD ["node", "server/main.js"]
