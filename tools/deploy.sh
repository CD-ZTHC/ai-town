#!/usr/bin/env bash
# 部署到线上（nohup 方式运行 mise run start）：
#   tools/deploy.sh [git 引用，默认 origin/main]
# 环境变量：DEPLOY_HOST（SSH 主机，默认 town）、DEPLOY_DIR（默认 /root/ai-town）、DEPLOY_PORT（健康检查端口，默认读线上 .env 的 PORT）
#
# 流程：新代码解压到 <目录>.new 并装好依赖（服务不停）→ 优雅停止（SIGTERM 时会存档）→
# 把 .env、存档、AI 插件、日志挪进新目录 → 切换目录并启动 → 健康检查，失败就切回旧版本。
# 旧版本保留为 <目录>.old-<时间>（只保留最近 3 个）。
set -euo pipefail
REF=${1:-origin/main}
HOST=${DEPLOY_HOST:-town}
DIR=${DEPLOY_DIR:-/root/ai-town}
cd "$(dirname "$0")/.."
git fetch -q origin
REV=$(git rev-parse --short "$REF")
TS=$(date +%Y%m%d-%H%M%S)
echo "▶ 部署 ${REV}（${REF}）到 $HOST:$DIR"

ssh "$HOST" "rm -rf '$DIR.new' && mkdir -p '$DIR.new'"
git archive "$REF" | ssh "$HOST" "tar -x -C '$DIR.new'"

ssh "$HOST" DIR="$DIR" REV="$REV" TS="$TS" PORT_OVERRIDE="${DEPLOY_PORT:-}" 'bash -s' <<'REMOTE'
set -euo pipefail
MISE=~/.local/bin/mise
NEW="$DIR.new"
OLD="$DIR.old-$TS"
cd "$NEW"
echo "$REV" > REVISION
cp -a "$DIR/.env" .env
"$MISE" trust -q .
# 依赖没变就沿用现有的 node_modules，否则重新安装
if [ -d "$DIR/node_modules" ] && cmp -s package-lock.json "$DIR/package-lock.json"; then
  cp -a "$DIR/node_modules" .
else
  "$MISE" exec -- npm ci --omit=dev --no-audit --no-fund --loglevel=error
fi
"$MISE" exec -- node tools/check.js >/dev/null

PORT=${PORT_OVERRIDE:-$(grep -E '^PORT=' .env | head -1 | sed -E 's/^PORT=([0-9]+).*/\1/')}
PORT=${PORT:-3000}
health() { curl -sf -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/"; }
stop() {
  for p in $(pgrep -f 'node server/index.js' || true); do
    [ "$(readlink "/proc/$p/cwd")" = "$1" ] || continue
    kill -TERM "$p"
    timeout 30 bash -c "while kill -0 $p 2>/dev/null; do sleep 0.5; done" || kill -KILL "$p"
  done
}
start() { (cd "$1" && setsid nohup "$MISE" run start > server.log 2>&1 < /dev/null &); timeout 40 bash -c "until curl -sf -o /dev/null --max-time 3 http://127.0.0.1:$PORT/; do sleep 1; done"; }

echo "▶ 停止旧版本（会先存档）"
stop "$DIR"
# 存档备份（只保留最近 5 份）
mkdir -p "$(dirname "$DIR")/ai-town-backups"
tar -czf "$(dirname "$DIR")/ai-town-backups/data-$TS.tgz" -C "$DIR" data
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
mv "$DIR" "$OLD"
mv "$NEW" "$DIR"

echo "▶ 启动新版本"
if start "$DIR"; then
  echo "✔ 已上线 ${REV}（端口 ${PORT}）"
  ls -dt "$DIR".old-* 2>/dev/null | tail -n +4 | xargs -r rm -rf
else
  echo "✖ 新版本没有正常响应，切回旧版本"
  tail -30 "$DIR/server.log" || true
  stop "$DIR"
  for f in data data.* plugins/evolved spec/mods/local .env.bak-*; do
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
