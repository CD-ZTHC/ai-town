# 云溪镇 · AI Town —— 零依赖，只需 Node 运行时
FROM node:26-alpine
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUBLIC_MODE=1
WORKDIR /app
# WITH_PI=1 时安装可选依赖 pi-ai（LLM_PROVIDER=pi 需要）：docker compose build --build-arg WITH_PI=1
ARG WITH_PI=0
COPY package.json package-lock.json ./
RUN if [ "$WITH_PI" = "1" ]; then npm ci --omit=dev --no-audit --no-fund && npm cache clean --force; fi
COPY server ./server
COPY public ./public
COPY spec ./spec
COPY plugin-host ./plugin-host
COPY plugins/builtin ./plugins/builtin
COPY evolution ./evolution
COPY core.lock ./
# data/：存档与进化状态；plugins/evolved/：AI 生成的插件（进化引擎只能写这两处）
RUN mkdir -p /app/data /app/plugins/evolved && chown -R node:node /app/data /app/plugins/evolved
USER node
VOLUME ["/app/data", "/app/plugins/evolved"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "server/main.js"]
