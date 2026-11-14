#!/usr/bin/env bash
# 输入公网 IPv4，输出独立 Redis 容器和仅供服务端使用的 Vercel 环境变量文件。
# 步骤：检查端口与目录 → 拉取并固定镜像 → 生成 IP 证书/账号 → 启动 → 本机验证。
set -euo pipefail
umask 077

if [[ ${EUID} -ne 0 || $# -ne 1 ]]; then
  echo "请以 root 执行：bash setup.sh 你的公网IPv4" >&2
  exit 1
fi
for executable in docker openssl python3 ss; do
  command -v "$executable" >/dev/null || { echo "缺少 $executable" >&2; exit 1; }
done
public_ip=$(python3 - "$1" <<'PY'
import ipaddress, sys
ip = ipaddress.IPv4Address(sys.argv[1])
if not ip.is_global:
    raise SystemExit('请输入公网 IPv4')
print(ip)
PY
)
target=/opt/multi-agent-redis
container=multi-agent-redis
if [[ -e "$target" ]] || docker container inspect "$container" >/dev/null 2>&1; then
  echo "目录或容器已存在，停止以避免覆盖数据或重新签发 CA：$target / $container" >&2
  exit 1
fi
if [[ -n $(ss -H -ltn 'sport = :6380') ]]; then
  echo "6380 端口已占用，停止安装" >&2
  exit 1
fi

# 支持从可信仓库拉取，或使用 docker load 导入的镜像，避免依赖服务器直连 Docker Hub。
image_ref=${REDIS_IMAGE:-redis:8}
if [[ ${REDIS_SKIP_PULL:-0} != 1 ]]; then
  docker pull "$image_ref"
fi
# save/load 后 RepoDigests 可能为空；本地内容 ID 同样固定镜像且不触发联网解析。
image=$(docker image inspect "$image_ref" --format '{{.Id}}')
redis_uid=$(docker run --rm --entrypoint id "$image" -u redis)
redis_gid=$(docker run --rm --entrypoint id "$image" -g redis)
module_paths=$(docker run --rm --entrypoint sh "$image" -c \
  'find / -type f \( -name rejson.so -o -name redisearch.so \) 2>/dev/null || true')
if ! printf '%s\n' "$module_paths" | grep -q '/rejson.so$' || \
   ! printf '%s\n' "$module_paths" | grep -q '/redisearch.so$'; then
  echo "镜像内未找到 JSON/Search 模块，停止；尚未创建实例目录" >&2
  exit 1
fi
mkdir -p "$target"/{ca-private,certs,data,config,backup}
cd "$target"
printf '%s\n' "$image" > image.txt

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
  -keyout ca-private/ca.key -out certs/ca.crt \
  -subj '/CN=Multi Agent Redis Private CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:2048 -nodes \
  -keyout certs/server.key -out ca-private/server.csr \
  -subj '/CN=Multi Agent Redis'
cat > ca-private/server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$public_ip,IP:127.0.0.1
EOF
openssl x509 -req -in ca-private/server.csr \
  -CA certs/ca.crt -CAkey ca-private/ca.key -CAcreateserial \
  -out certs/server.crt -days 365 -sha256 -extfile ca-private/server.ext
openssl verify -CAfile certs/ca.crt -verify_ip "$public_ip" certs/server.crt

password=$(openssl rand -hex 32)
password_hash=$(printf '%s' "$password" | openssl dgst -sha256 -r | cut -d ' ' -f 1)
# 独立实例的业务账号可操作全部业务数据，但禁止改服务配置、账号、清库和复制拓扑。
printf 'user default off\nuser app on #%s ~* &* +@all -config -acl -shutdown -debug -module -flushall -flushdb -replicaof -slaveof -migrate\n' \
  "$password_hash" > config/users.acl
cat > config/redis.conf <<'EOF'
bind 0.0.0.0
protected-mode yes
port 0
tls-port 6380
tls-cert-file /certs/server.crt
tls-key-file /certs/server.key
tls-ca-cert-file /certs/ca.crt
tls-auth-clients no
tls-protocols "TLSv1.2 TLSv1.3"
aclfile /config/users.acl
dir /data
appendonly yes
appendfsync everysec
# 留出容器内索引、连接与持久化的余量；内存不足时拒绝写入，不能静默淘汰会话/锁。
maxmemory 96mb
maxmemory-policy noeviction
maxclients 100
logfile ""
EOF
# 自定义配置替代镜像默认配置时，需要显式加载模块。
while IFS= read -r module_path; do
  printf 'loadmodule "%s"\n' "$module_path" >> config/redis.conf
done <<< "$module_paths"
chown -R "$redis_uid:$redis_gid" certs config data
chmod 750 certs config data
chmod 640 certs/* config/*

python3 - "$public_ip" "$password" <<'PY'
import json, sys
from pathlib import Path
ip, password = sys.argv[1:]
ca = Path('certs/ca.crt').read_text()
Path('vercel.env').write_text(
    f'REDIS_URL=rediss://app:{password}@{ip}:6380\n'
    f'REDIS_CA_CERT={json.dumps(ca)}\n'
)
Path('cli.env').write_text(f'REDISCLI_AUTH={password}\n')
PY

docker run -d --name "$container" --restart unless-stopped \
  --entrypoint redis-server \
  --memory 256m --memory-swap 256m --cpus 0.5 \
  --user "$redis_uid:$redis_gid" \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --log-opt max-size=10m --log-opt max-file=2 \
  -p 0.0.0.0:6380:6380 \
  -v "$target/data:/data" \
  -v "$target/certs:/certs:ro" \
  -v "$target/config:/config:ro" \
  "$image" /config/redis.conf

# 复用容器网络命名空间验证真实 TLS、认证与模块命令，不改动旧实例。
ready=false
for attempt in {1..20}; do
  if docker run --rm --network "container:$container" \
    --env-file cli.env -v "$target/certs/ca.crt:/ca.crt:ro" \
    "$image" redis-cli --tls --cacert /ca.crt --user app -h 127.0.0.1 -p 6380 PING | grep -qx PONG; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "启动验证失败，请查看 docker logs $container；不要开放安全组端口" >&2
  exit 1
fi
for command in JSON.SET FT.CREATE; do
  result=$(docker run --rm --network "container:$container" \
    --env-file cli.env -v "$target/certs/ca.crt:/ca.crt:ro" \
    "$image" redis-cli --tls --cacert /ca.crt --user app -h 127.0.0.1 -p 6380 --raw COMMAND INFO "$command")
  if [[ -z "$result" || "$result" == *ERR* || "$result" == *NOPERM* ]]; then
    echo "$command 不可用，停止：请检查镜像或账号权限" >&2
    exit 1
  fi
done
echo "本机 TLS、密码及 JSON/Search 命令验证通过。"
echo "Vercel 配置已保存到 $target/vercel.env，请私下读取，不要粘贴到聊天。"
echo "下一步：配置安全组、从本地验证两种客户端、更新 Vercel 环境变量并重新部署。"
