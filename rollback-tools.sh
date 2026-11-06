#!/usr/bin/env bash
# 只回滚 hotel-tools 工具集服务。
# 不触碰酒店小程序 / 后台的目录、容器、网络、数据卷。
#
# 用法：
#   ./rollback-tools.sh <上一版镜像@sha256:...>
#   ./rollback-tools.sh --stop     # 首次部署无上一版时，只停工具服务

set -Eeuo pipefail

PROJECT="${TOOLS_PROJECT:-hotel-tools}"
BASE_DIR="${TOOLS_BASE_DIR:-/opt/hotel-tools}"
COMPOSE_FILE="${BASE_DIR}/compose.yml"
ENV_FILE="${BASE_DIR}/.env"

die() { echo "✖ $*" >&2; exit 1; }
info() { echo "• $*"; }

[[ -f "$COMPOSE_FILE" ]] || die "缺少 $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "缺少 $ENV_FILE"

compose() {
  docker compose --project-name "$PROJECT" --file "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

if [[ "${1:-}" == "--stop" ]]; then
  info "停止 tools 服务（保留数据卷与日志）"
  compose stop tools
  info "已停止。请由用户决定是否移除新增的 tools 主机名路由。"
  info "不要删除数据卷、不要执行酒店项目部署脚本、不要重启 Docker 或服务器。"
  exit 0
fi

target="${1:-}"
[[ -n "$target" ]] || die "请提供上一版镜像（带 digest），或使用 --stop"
[[ "$target" == *"@sha256:"* ]] || die "镜像必须带 digest（形如 repo/name@sha256:...）"

info "暂停新任务：先停服务"
compose stop tools

info "备份当前 .env"
cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"

info "回退 TOOLS_IMAGE"
if grep -q '^TOOLS_IMAGE=' "$ENV_FILE"; then
  sed -i.tmp "s|^TOOLS_IMAGE=.*|TOOLS_IMAGE=${target}|" "$ENV_FILE"
  rm -f "${ENV_FILE}.tmp"
else
  echo "TOOLS_IMAGE=${target}" >> "$ENV_FILE"
fi

info "拉取上一版镜像"
compose pull tools

info "启动上一版"
compose up -d --no-build --no-deps tools

info "等待健康检查（最多 60 秒）"
HEALTH_OK=0
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${TOOLS_CONTAINER_NAME:-hotel-tools}" 2>/dev/null || echo missing)"
  if [[ "$status" == "healthy" ]]; then HEALTH_OK=1; info "容器健康"; break; fi
  if [[ "$status" == "unhealthy" ]]; then compose logs --tail=80 tools || true; die "回滚后仍不健康，请人工介入"; fi
  sleep 2
done

if [[ "$HEALTH_OK" -ne 1 ]]; then
  compose logs --tail=80 tools || true
  die "回滚后健康检查超时未通过，回滚未成功"
fi

PROJECT_LABEL="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${TOOLS_CONTAINER_NAME:-hotel-tools}" 2>/dev/null || echo '')"
if [[ "$PROJECT_LABEL" != "$PROJECT" ]]; then
  die "容器项目标签为 '${PROJECT_LABEL}'，不是 '${PROJECT}'，停止操作"
fi

info "回滚完成（健康检查通过）。失败任务不会被显示为成功，请提示用户重新提交。"
