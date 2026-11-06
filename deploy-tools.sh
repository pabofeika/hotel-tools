#!/usr/bin/env bash
# 只更新 hotel-tools 工具集服务。
# 不触碰酒店小程序 / 后台的目录、容器、网络、数据卷。
#
# 用法：
#   ./deploy-tools.sh            # 使用 /opt/hotel-tools/.env 中的 TOOLS_IMAGE
#   ./deploy-tools.sh <digest>   # 临时指定镜像 digest（会写回 .env）

set -Eeuo pipefail

PROJECT="${TOOLS_PROJECT:-hotel-tools}"
BASE_DIR="${TOOLS_BASE_DIR:-/opt/hotel-tools}"
COMPOSE_FILE="${BASE_DIR}/compose.yml"
ENV_FILE="${BASE_DIR}/.env"

die() { echo "✖ $*" >&2; exit 1; }
info() { echo "• $*"; }

[[ -f "$COMPOSE_FILE" ]] || die "缺少 $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE（从 .env.example 复制并填好 TOOLS_IMAGE）"

# 显式项目名 + 文件路径，避免误操作其他 Compose 项目
compose() {
  docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if [[ $# -ge 1 ]]; then
  new_image="$1"
  [[ "$new_image" == *"@sha256:"* ]] || die "镜像必须带 digest（形如 repo/name@sha256:...）"
  info "更新 .env 中的 TOOLS_IMAGE"
  cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  if grep -q '^TOOLS_IMAGE=' "$ENV_FILE"; then
    sed -i.tmp "s|^TOOLS_IMAGE=.*|TOOLS_IMAGE=${new_image}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.tmp"
  else
    echo "TOOLS_IMAGE=${new_image}" >> "$ENV_FILE"
  fi
fi

info "校验 compose 配置"
compose config --quiet

info "拉取镜像"
compose pull tools

info "启动（只动 tools 服务）"
compose up -d --no-build --no-deps tools

info "等待健康检查（最多 60 秒）"
HEALTH_OK=0
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${TOOLS_CONTAINER_NAME:-hotel-tools}" 2>/dev/null || echo missing)"
  if [[ "$status" == "healthy" ]]; then
    HEALTH_OK=1
    info "容器健康"
    break
  fi
  if [[ "$status" == "unhealthy" ]]; then
    compose logs --tail=80 tools || true
    die "容器不健康，请按 docs/operations.md 回滚"
  fi
  sleep 2
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  compose logs --tail=80 tools || true
  die "健康检查超时未通过（60 秒内未 healthy），视为发布失败"
fi

# 确认容器确实属于本项目，避免误判到同名容器
PROJECT_LABEL="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${TOOLS_CONTAINER_NAME:-hotel-tools}" 2>/dev/null || echo '')"
if [[ "$PROJECT_LABEL" != "$PROJECT" ]]; then
  die "容器 ${TOOLS_CONTAINER_NAME:-hotel-tools} 的项目标签为 '${PROJECT_LABEL}'，不是 '${PROJECT}'，停止操作"
fi

info "能力自检"
compose exec -T tools node -e "
fetch('http://127.0.0.1:8765/api/capabilities')
  .then(r => r.json())
  .then(d => {
    const c = d.capabilities || {};
    console.log('video            :', c.video);
    console.log('vectorizeNative  :', c.vectorizeNative);
    if (!c.video || !c.vectorizeNative) {
      console.error('依赖不全，不要放开门户入口');
      process.exit(1);
    }
  })
  .catch(e => { console.error('能力自检失败', e.message); process.exit(1); });
" || die "能力自检失败，请检查镜像依赖"

info "完成：hotel-tools 已更新"
info "查看日志：docker compose --project-name $PROJECT --file $COMPOSE_FILE --env-file $ENV_FILE logs -f tools"
