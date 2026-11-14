# 阿里云公网 IP Redis TLS 部署

适用于本项目：保留 Ubuntu 上原 Redis 6 的 `127.0.0.1:6379`，用 Docker 独立运行 Redis 8，在 `6380` 提供 TLS。使用私有 CA 和包含公网 IP SAN 的服务端证书，不需要域名。网站的 HTTPS 证书无需调整。

## 1. 上传安装脚本

在本地项目根目录执行（按实际 SSH 用户/密钥调整）：

```bash
scp deploy/redis/setup.sh root@112.126.27.148:/root/multi-agent-redis-setup.sh
```

## 2. 在阿里云服务器安装

先不要在安全组开放 6380。SSH 登录服务器，以 root 执行：

```bash
bash /root/multi-agent-redis-setup.sh 112.126.27.148
```

脚本需要 Docker、OpenSSL、Python 3、ss，可用 `apt-get install openssl python3 iproute2` 安装缺失工具。Docker Hub 拉取失败时先解决镜像网络访问，脚本不会改原有 Redis。脚本拒绝覆盖已有目录/容器；中途失败后检查错误，不要删除数据后盲目重跑。

### Docker Hub 超时：离线导入官方镜像

服务器无法访问 Docker Hub 时，可在一台已安装 Docker、能访问 Docker Hub 的电脑上下载官方镜像，再用 SSH 传输。当前服务器为 x86_64，Apple 芯片 Mac 也必须指定 `linux/amd64`：

```bash
docker pull --platform linux/amd64 redis:8
docker save -o /tmp/multi-agent-redis8-amd64.tar redis:8
scp /tmp/multi-agent-redis8-amd64.tar root@112.126.27.148:/root/
scp deploy/redis/setup.sh root@112.126.27.148:/root/multi-agent-redis-setup.sh
```

然后在服务器执行：

```bash
docker load -i /root/multi-agent-redis8-amd64.tar
REDIS_SKIP_PULL=1 bash /root/multi-agent-redis-setup.sh 112.126.27.148
```

更新后的脚本支持跳过拉取，使用本地镜像内容 ID，不依赖导入后可能缺失的 RepoDigests。此方式无需修改 Docker daemon 或重启已有容器。如果使用自己同步的可信镜像仓库，可设置 `REDIS_IMAGE=仓库地址/命名空间/redis:版本` 执行脚本。

参考：[Docker 镜像导出](https://docs.docker.com/reference/cli/docker/image/save/)。阿里云已说明其旧镜像加速服务停止同步最新镜像，不能保证通过旧加速地址获取 Redis 8：[阿里云镜像加速说明](https://help.aliyun.com/zh/acr/user-guide/accelerate-the-pulls-of-docker-official-images)。

脚本会创建 `/opt/multi-agent-redis`，固定镜像摘要、生成随机密码和 IP 证书，启用 AOF；显式加载 JSON/Search，验证本机 TLS、账号密码及模块命令。CA 有效期十年，服务端证书一年。

启动时通过 `--entrypoint redis-server` 直接运行服务端，由项目配置负责加载模块，避免镜像的默认启动脚本再次加载相同模块。

### 旧脚本安装后 Search 重复加载导致重启

若日志先出现 `Module 'search' loaded`，之后再次出现 `redisearch.so initialization failed`，且 OOM 为 false，说明模块重复加载。对于已由镜像默认入口自动加载模块的实例，停止容器并移除项目配置中的手动加载指令即可。不要重跑 setup，也不要删除数据、证书或密码文件。

```bash
docker stop multi-agent-redis
cp -p /opt/multi-agent-redis/config/redis.conf /opt/multi-agent-redis/config/redis.conf.before-module-fix
sed -i '/^[[:space:]]*loadmodule[[:space:]]/d' /opt/multi-agent-redis/config/redis.conf
docker start multi-agent-redis
docker logs --since 1m --tail 60 multi-agent-redis
docker inspect --format '状态={{.State.Status}} OOM={{.State.OOMKilled}} 退出码={{.State.ExitCode}} 重启次数={{.RestartCount}}' multi-agent-redis
```

此操作适用于这里的旧实例，依赖其默认入口加载 JSON/Search；新脚本直接运行二进制，需要保留配置中的显式加载指令。备份配置保留原文件属主和权限。修复后仍需按后文完成 TLS 和模块读写验收。

资源配置是小规模试用起点：容器 256 MiB、Redis 数据上限 96 MiB、0.5 CPU、最多 100 连接；超过数据上限拒绝写入，不淘汰会话或运行锁。索引、连接和 AOF 仍可能令容器 OOM，不能保证当前约 457 MiB 可用内存足够。脚本的验证客户端也会临时占用内存。启动失败时先查看日志和 OOM 状态，必要时停止新容器，评估是否增加内存。

```bash
docker logs --tail 100 multi-agent-redis
docker stats --no-stream multi-agent-redis
docker inspect --format '{{.State.OOMKilled}} {{.RestartCount}}' multi-agent-redis
```

## 3. 配置网络入口

在阿里云 ECS 实例关联的安全组中添加入站 TCP 6380。先只允许你电脑的公网 IP `/32` 完成本地验证。没有固定 Vercel 出口 IP 时，部署最终需要允许动态来源访问，例如 IPv4 `0.0.0.0/0`；这允许互联网尝试建立 TLS 连接，只有持有密码的客户端才能操作数据。

只开放新实例的 TLS 端口，不开放旧 6379。检查安全组原有规则有没有覆盖全部端口的宽泛放行。TLS 不替代密码认证和安全更新。Docker 发布端口可能绕过 UFW 的普通规则，不能仅依赖 `ufw deny`；以云安全组控制入口，必要时按 Docker 文档配置 Docker 防火墙规则。

参考：[Redis TLS](https://redis.io/docs/latest/operate/oss_and_stack/management/security/encryption/)、[Redis 配置与模块加载](https://redis.io/docs/latest/operate/oss_and_stack/management/config/)、[Docker 防火墙](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

## 4. 从本地验证两种客户端

安装脚本生成 `vercel.env`，包含密码和 CA 公共证书。在本地项目目录安全下载该文件：

```bash
scp root@112.126.27.148:/opt/multi-agent-redis/vercel.env .env.redis-migration
chmod 600 .env.redis-migration
node --env-file=.env.redis-migration scripts/check-redis-tls.mjs
```

使用 Node 20.12+ 或 Node 22+。`.env.redis-migration` 已被项目的 `.env*` 忽略规则排除。检查脚本实际验证 ioredis、node-redis 的证书/认证，并写入短期测试文档、创建 Search 索引后查询，最后清理测试数据。它不会访问原 Redis 或修改业务数据。

私下保存这份环境变量文件，不要粘贴到聊天或提交 Git。脚本运行通过后，去掉 CA 或换成错误 CA 应连接失败；错误密码也应失败，正式部署前可复制环境变量文件在副本中验证。禁止使用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或 `rejectUnauthorized: false`。

### 本地 Next.js 开发环境

`.env.redis-migration` 只在显式指定 `node --env-file=.env.redis-migration` 时被读取；Next.js 不会自动加载这个自定义文件。要运行 `npm run dev`，将其中的 `REDIS_URL` 和 `REDIS_CA_CERT` 合入项目根目录的 `.env.local`，保留原有其他变量，然后停止并重新启动开发服务。不要用迁移文件覆盖整个 `.env.local`。不要通过日志打印连接地址或环境变量值。

## 5. 更新 Vercel

项目代码已增加 `REDIS_CA_CERT` 支持。先把本次代码提交到 Vercel 对应的仓库/分支；仅修改环境变量而未部署新代码，RedisSaver 仍不会信任你的 CA。

打开 Vercel 项目的 Settings → Environment Variables，更新以下两个服务端变量：

- `REDIS_URL`：取文件第一行等号右边的完整地址，形如 `rediss://app:随机密码@112.126.27.148:6380`。
- `REDIS_CA_CERT`：取第二行引号内部的证书内容；可以直接粘贴带字面 `\n` 的内容，代码会还原换行。不要复制外围双引号。也可以将服务器 `certs/ca.crt` 的完整多行内容粘贴到变量值。

选择 Production；预览部署需要使用时再选择 Preview。变量不要加 `NEXT_PUBLIC_` 前缀。Vercel 不需要服务器私钥或 CA 私钥。重新部署后验证聊天连续两轮、历史消息、工作流运行与 SSE 重连。查看函数日志是否出现证书、认证、缺少 JSON/Search 命令或 OOM 错误。

原厂商已删除的数据不会自动恢复；原服务器 Redis 数据也不会自动复制到新实例。

## 6. 后续维护

**备份：** AOF 是持久化，不是异机备份。小规模试用可在无运行任务的维护窗口停止新容器，归档整个 data 目录，再立即启动。停止期间本项目 Redis 功能不可用，旧实例不受影响。

```bash
docker stop multi-agent-redis
tar -C /opt/multi-agent-redis -czf /opt/multi-agent-redis/backup/data-$(date +%Y%m%d-%H%M%S).tgz data
docker start multi-agent-redis
```

将归档安全复制到其他机器/备份存储，并试验恢复。另行安全备份 config、certs、ca-private、image.txt 和环境变量文件；其中包含私钥/密码。私有 CA 密钥未挂载到运行容器。

**证书续期：** 服务端证书一年到期，建议设到期前 30 天提醒。下面的命令在原 CA 下重新签发，Vercel 的 CA 环境变量无需修改。IP 变化时，先更新 `server.ext` 中的公网 IP SAN，同时更新 Vercel URL。

```bash
cd /opt/multi-agent-redis
openssl x509 -req -in ca-private/server.csr -CA certs/ca.crt -CAkey ca-private/ca.key -CAcreateserial -out certs/server.crt.new -days 365 -sha256 -extfile ca-private/server.ext
openssl verify -CAfile certs/ca.crt -verify_ip 112.126.27.148 certs/server.crt.new
chown --reference=certs/server.crt certs/server.crt.new
chmod 640 certs/server.crt.new
mv certs/server.crt.new certs/server.crt
docker restart multi-agent-redis
```

**内存：** 经常检查 `docker stats` 与 OOM 状态。出现 OOM 或写入内存不足时，停止新服务或增加资源后再调整限制，避免反复重启。增加 Swap 不能代替足够的内存。

**升级与回退：** 记录固定镜像摘要，定期检查安全更新。升级前备份并在独立实例试验，不自动执行 `docker pull` 后重建。需要停止迁移时关闭安全组 6380 并停止新容器；只有旧云 Redis 仍可用时，恢复旧环境变量/代码才构成可用的回退。

本地校验包含纯配置单元测试、代码检查与脚本语法检查；本地没有 Docker，尚未实际执行服务器安装或跨公网验收。
