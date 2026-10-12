#!/usr/bin/env bash
# 部署到线上：
#   tools/deploy.sh [git 引用，默认 origin/main]
# 环境变量：
#   DEPLOY_HOST  SSH 主机，默认 town
#   DEPLOY_MODE  systemd / nohup / auto（默认 auto：线上启用了 ai-town.service 就用 systemd）
#   DEPLOY_DIR   默认 systemd 模式 /opt/ai-town，nohup 模式 /root/ai-town
#   DEPLOY_PORT  健康检查端口，默认读线上 .env 的 PORT
#
# 流程（重构方案 P1 §5.1、§5.5）：
#   本机：取出代码 → 装生产依赖（npm ci --omit=dev，依赖都是纯 JS，与平台无关）→ 语法检查 → 打包上传到 <目录>.new
#   线上：用线上的 .env 校验新版本的设置 → 优雅停止（SIGTERM 时会存档）→ 备份存档 →
#         把 .env、存档、AI 插件、日志挪进新目录 → 切换目录并启动 → 健康检查，失败就切回旧版本。
#   线上不再安装依赖、不再跑检查：部署瞬间不在生产机上制造额外的内存峰值（M5）。
# 旧版本保留为 <目录>.old-<时间>（只保留最近 3 个）。
set -euo pipefail
REF=${1:-origin/main}
HOST=${DEPLOY_HOST:-town}
MODE=${DEPLOY_MODE:-auto}
cd "$(dirname "$0")/.."
git fetch -q origin
REV=$(git rev-parse --short "$REF")
TS=$(date +%Y%m%d-%H%M%S)

if [ "$MODE" = auto ]; then
  if ssh "$HOST" 'systemctl is-enabled ai-town >/dev/null 2>&1'; then MODE=systemd; else MODE=nohup; fi
fi
case "$MODE" in
  systemd) DIR=${DEPLOY_DIR:-/opt/ai-town} ;;
  nohup) DIR=${DEPLOY_DIR:-/root/ai-town} ;;
  *) echo "✖ DEPLOY_MODE 只能是 systemd / nohup / auto" >&2; exit 1 ;;
esac
echo "▶ 部署 ${REV}（${REF}）到 ${HOST}:${DIR}（${MODE}）"

# ---------- 本机构建 ----------
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
git archive "$REF" | tar -x -C "$BUILD"
echo "$REV" > "$BUILD/REVISION"
(cd "$BUILD" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
(cd "$BUILD" && node tools/check.ts >/dev/null)
echo "▶ 上传（$(du -sh "$BUILD" | cut -f1)）"
ssh "$HOST" "rm -rf '$DIR.new' && mkdir -p '$DIR.new'"
# macOS 的 tar 会把扩展属性打包成 ._<文件名>（AppleDouble）：._*.json 会被当成世界包读取，启动直接失败。
# COPYFILE_DISABLE 让 bsdtar 不生成它们（GNU tar 忽略这个变量）；线上解包后再删一遍兜底
COPYFILE_DISABLE=1 tar -czf - -C "$BUILD" . | ssh "$HOST" "tar -xzf - -C '$DIR.new' && find '$DIR.new' -name '._*' -delete"

# ---------- 线上切换 ----------
ssh "$HOST" DIR="$DIR" REV="$REV" TS="$TS" MODE="$MODE" PORT_OVERRIDE="${DEPLOY_PORT:-}" 'bash -s' <<'REMOTE'
set -euo pipefail
NEW="$DIR.new"
OLD="$DIR.old-$TS"
cd "$NEW"
cp -a "$DIR/.env" .env
if [ "$MODE" = systemd ]; then
  NODE=/opt/node/bin/node
  run_node() { "$NODE" "$@"; }
else
  MISE=~/.local/bin/mise
  "$MISE" trust -q .
  run_node() { "$MISE" exec -- node "$@"; }
fi
# systemd 的 EnvironmentFile 不支持行内注释（「KEY=90  # 说明」会把注释也当成值），Node 的 --env-file 却会去掉它：
# 两边解析不一致时直接拒绝，避免检查通过、上线后却读到带注释的值
if [ "$MODE" = systemd ] && grep -nE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^"'"'"']*#' .env; then
  echo '✖ 线上 .env 有行内注释（上面这些行），systemd 会把注释当成值的一部分：请把注释移到单独的一行' >&2
  exit 1
fi
# 新版本会校验环境变量（写错就拒绝启动）：在停掉旧版本之前先用线上的 .env 检查一遍，不通过就放弃部署
run_node --env-file=.env --input-type=module -e "import('./server/settings/index.ts').then((s) => { const p = s.envProblems(); if (p.length) { console.error('✖ 线上 .env 有不合法的设置：\\n  ' + p.join('\\n  ')); process.exit(1); } })"

PORT=${PORT_OVERRIDE:-$(grep -E '^PORT=' .env | head -1 | sed -E 's/^PORT=([0-9]+).*/\1/')}
PORT=${PORT:-3000}
health() { timeout 40 bash -c "until curl -sf -o /dev/null --max-time 3 http://127.0.0.1:$PORT/healthz; do sleep 1; done"; }
if [ "$MODE" = systemd ]; then
  stop() { systemctl stop ai-town; }
  start() { systemctl start ai-town && health; }
else
  stop() {
    # 先停守护进程（它会带着服务进程一起退出），再停没有守护进程的旧版本
    for pat in 'node server/main\.[jt]s' 'node server/index\.[jt]s'; do
      for p in $(pgrep -f "$pat" || true); do
        [ "$(readlink "/proc/$p/cwd")" = "$1" ] || continue
        kill -TERM "$p"
        timeout 30 bash -c "while kill -0 $p 2>/dev/null; do sleep 0.5; done" || kill -KILL "$p"
      done
    done
  }
  start() { (cd "$1" && exec setsid nohup "$MISE" run start > server.log 2>&1 < /dev/null) > /dev/null 2>&1 < /dev/null & health; }
fi

echo "▶ 停止旧版本（会先存档）"
stop "$DIR"
# 存档备份（只保留最近 5 份）
mkdir -p "$(dirname "$DIR")/ai-town-backups"
# 连同 AI 插件一起备份：新版本首次启动会把旧目录迁移到 data/worlds/<世界>/，回滚时要从这份备份恢复
BACKUP="$(dirname "$DIR")/ai-town-backups/data-$TS.tgz"
tar -czf "$BACKUP" -C "$DIR" data $( [ -d "$DIR/plugins/evolved" ] && echo plugins/evolved )
ls -t "$(dirname "$DIR")"/ai-town-backups/data-*.tgz | tail -n +6 | xargs -r rm -f
# 运行时产生、不在 git 里的东西：挪进新目录
for f in data data.* plugins/evolved spec/mods/local .env.bak-* server.log*; do
  for src in "$DIR"/$f; do
    [ -e "$src" ] || continue
    rel=${src#"$DIR"/}
    mkdir -p "$(dirname "$NEW/$rel")"
    rm -rf "$NEW/$rel"
    mv "$src" "$NEW/$rel"
  done
done
[ -f "$NEW/server.log" ] && mv "$NEW/server.log" "$NEW/server.log.$TS"
# systemd 模式：代码归 root 只读，服务用户只能写 data/（ProtectSystem=strict + ReadWritePaths）
# 本机的构建目录是 mktemp 建的（700），打包时带过来了：服务用户要能进入程序目录
chmod 755 "$NEW"
[ "$MODE" = systemd ] && chown -R aitown:aitown "$NEW/data" && chmod 640 "$NEW/.env" && chgrp aitown "$NEW/.env"
mv "$DIR" "$OLD"
mv "$NEW" "$DIR"

echo "▶ 启动新版本"
if start "$DIR"; then
  echo "✔ 已上线 ${REV}（端口 ${PORT}）"
  ls -dt "$DIR".old-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
else
  echo "✖ 新版本没有正常响应，切回旧版本"
  if [ "$MODE" = systemd ]; then journalctl -u ai-town -n 30 --no-pager || true; else tail -30 "$DIR/server.log" || true; fi
  stop "$DIR"
  # 存档与插件从部署前的备份恢复（新版本可能已经把它们迁移成了新的目录结构）
  rm -rf "$DIR/data" "$DIR/plugins/evolved"
  tar -xzf "$BACKUP" -C "$OLD"
  [ "$MODE" = systemd ] && chown -R aitown:aitown "$OLD/data"
  for f in data.* spec/mods/local .env.bak-*; do
    for src in "$DIR"/$f; do
      [ -e "$src" ] || continue
      rel=${src#"$DIR"/}
      mkdir -p "$(dirname "$OLD/$rel")"
      rm -rf "$OLD/$rel"
      mv "$src" "$OLD/$rel"
    done
  done
  mv "$DIR" "$DIR.failed-$TS"
  mv "$OLD" "$DIR"
  start "$DIR" && echo "已恢复旧版本"
  exit 1
fi
REMOTE
