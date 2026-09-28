#!/usr/bin/env bash
# 一次性迁移（重构方案 P1 §5.1、M1、M9）：把 nohup 方式运行的 /root/ai-town 迁到 systemd 管理的 /opt/ai-town。
#   ssh town 'bash -s' < deploy/migrate-to-systemd.sh
# 做的事：
#   1. 安装与现在相同版本的 Node 官方二进制到 /opt/node（systemd 直接启动 node，不经过 mise，省一个约 40MB 的包装进程）
#   2. 建立系统用户 aitown（服务以它运行；ProtectHome=true 读不到 /root，所以目录要迁到 /opt）
#   3. 停掉 nohup 的旧进程（SIGTERM 会存档）→ 复制到 /opt/ai-town（/root/ai-town 原样保留，用于回退）
#   4. .env 里的行内注释移到单独一行（systemd 的 EnvironmentFile 会把行内注释当成值）
#   5. 安装并启动 ai-town.service，健康检查；失败自动回到 nohup 方式
# 之后 tools/deploy.sh 会自动识别 systemd 模式（部署到 /opt/ai-town）。确认稳定一周后可以删除 /root/ai-town。
set -euo pipefail
SRC=${SRC:-/root/ai-town}
DST=${DST:-/opt/ai-town}
MISE=~/.local/bin/mise
[ "$(id -u)" = 0 ] || { echo '✖ 需要 root' >&2; exit 1; }
[ -d "$SRC" ] || { echo "✖ 找不到 $SRC" >&2; exit 1; }
[ -e "$DST" ] && { echo "✖ $DST 已存在（已经迁移过？）" >&2; exit 1; }
PORT=$(grep -E '^PORT=' "$SRC/.env" | head -1 | sed -E 's/^PORT=([0-9]+).*/\1/')
PORT=${PORT:-3000}

# ---------- 1. Node ----------
VER=$(cd "$SRC" && "$MISE" exec -- node -v)
ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; esac
if [ "$(/opt/node/bin/node -v 2>/dev/null || true)" != "$VER" ]; then
  echo "▶ 安装 Node $VER 到 /opt/node"
  T=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-linux-$ARCH.tar.xz" -o "$T/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$VER/SHASUMS256.txt" -o "$T/SHASUMS256.txt"
  (cd "$T" && grep " node-$VER-linux-$ARCH.tar.xz\$" SHASUMS256.txt | sed "s/node-$VER-linux-$ARCH.tar.xz/node.tar.xz/" | sha256sum -c -)
  rm -rf /opt/node.new && mkdir -p /opt/node.new
  tar -xJf "$T/node.tar.xz" -C /opt/node.new --strip-components=1
  rm -rf /opt/node && mv /opt/node.new /opt/node
  rm -rf "$T"
fi

# ---------- 2. 用户 ----------
id aitown >/dev/null 2>&1 || useradd --system --home-dir "$DST" --no-create-home --shell /usr/sbin/nologin aitown

# ---------- 3. 停止旧进程、复制 ----------
echo "▶ 停止 nohup 方式运行的旧进程（会先存档）"
for pat in 'node server/main\.[jt]s' 'node server/index\.[jt]s'; do
  for p in $(pgrep -f "$pat" || true); do
    [ "$(readlink "/proc/$p/cwd")" = "$SRC" ] || continue
    kill -TERM "$p"
    timeout 30 bash -c "while kill -0 $p 2>/dev/null; do sleep 0.5; done" || kill -KILL "$p"
  done
done
echo "▶ 复制 $SRC → $DST"
mkdir -p "$DST"
tar -C "$SRC" --exclude='./server.log*' -cf - . | tar -C "$DST" -xf -
chown -R root:root "$DST"
mkdir -p "$DST/data"
chown -R aitown:aitown "$DST/data"
for d in plugins/evolved spec/mods/local; do [ -d "$DST/$d" ] && chown -R aitown:aitown "$DST/$d"; done

# ---------- 4. .env ----------
# 「KEY=值   # 说明」→「# 说明」+「KEY=值」（带引号的值不动）
awk '
  /^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^"\047]*[[:space:]]#/ {
    i = index($0, "#"); val = substr($0, 1, i - 1); sub(/[[:space:]]+$/, "", val)
    print "# " substr($0, i + 1); print val; next
  }
  { print }
' "$SRC/.env" > "$DST/.env"
chown root:aitown "$DST/.env"
chmod 640 "$DST/.env"

# ---------- 5. systemd ----------
sed -e "s#^Environment=NODE_ENV=production PUBLIC_MODE=1 TRUST_PROXY=1 HOST=127.0.0.1 PORT=3000#Environment=NODE_ENV=production PUBLIC_MODE=1 TRUST_PROXY=1 HOST=127.0.0.1 PORT=$PORT#" \
  "$DST/deploy/ai-town.service" > /etc/systemd/system/ai-town.service
systemctl daemon-reload
systemctl enable --now ai-town
if timeout 60 bash -c "until curl -sf -o /dev/null --max-time 3 http://127.0.0.1:$PORT/healthz; do sleep 1; done"; then
  echo "✔ 已改由 systemd 运行：systemctl status ai-town；日志 journalctl -u ai-town -f"
  echo "  旧目录 $SRC 保留作回退，确认稳定后可以删除"
else
  echo "✖ systemd 方式没有正常启动，回到 nohup 方式" >&2
  journalctl -u ai-town -n 40 --no-pager || true
  systemctl disable --now ai-town || true
  (cd "$SRC" && exec setsid nohup "$MISE" run start > server.log 2>&1 < /dev/null) > /dev/null 2>&1 < /dev/null &
  exit 1
fi
