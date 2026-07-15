# 医疗 Agentic RAG · K8s 多活部署（T15）

## 架构原则（压测结论驱动）

Pi 在本机/本 KB 为**单实例**：任意第二个并发 Pi 进程会硬崩（Windows `code=3221225794` / 静默 `exit 1`，根因是共享 `~/.pi/knowledge` 的 WAL 写锁争用）。因此：

- **每 Pod 一个 Pi（串行）**：所有 ask 路由到同一 Pi worker，由 `PiWorker._askLock` 串行化；并发吞吐靠 HPA 横向扩 **Pod**，而非多 Pi。
- **每 Pod 独立 KB 副本**：initContainer 把共享 KB 源拷贝到 emptyDir，Pi 独占写锁，根除崩溃。
- **会话亲和**：Ingress cookie 亲和，使同一客户端黏到同 Pod，保留多轮对话上下文。
- **过载保护**：会话数达上限或 worker 失效时返回 `429`（PoolFullError / CircuitOpen）。
- **优雅关停**：preStop 发 `SIGTERM` → api-server 停收新请求 → 排干在途（≤`API_DRAIN_MS`）→ 强杀 Pi 整棵子树（`dispose`），根治孤儿 Pi 持锁饿死新实例。

## 目录

| 文件 | 作用 |
|------|------|
| `namespace.yaml` | 专属命名空间（等保隔离） |
| `configmap.yaml` | 运行期配置（`PI_KNOWLEDGE_WATCH=false`、端口、排水窗口等） |
| `secret.yaml` | 密钥模板（**勿提交真实值**） |
| `service.yaml` | ClusterIP |
| `ingress.yaml` | nginx cookie 会话亲和 + TLS |
| `hpa.yaml` | 副本 2–10，CPU 70% 触发扩缩 |
| `deployment.yaml` | 2 副本 + initContainer 拷贝 KB + 探针 + preStop |
| `kb-pvc.yaml` | 共享 KB 源（RWX） |
| `kb-build-job.yaml` | 一次性 KB 构建进 PVC |
| `../scripts/ops/provision-kb.mjs` | initContainer/Job 调用的 KB 拷贝或构建脚本 |

## 部署步骤

```bash
# 0) 构建镜像（含 better-sqlite3 对镜像 node 的重建）
#    docker build -t medical-agentic-rag:latest .
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml

# 1) 注入密钥（勿用仓库内的占位 secret.yaml 提交真实值）
kubectl -n medical-rag create secret generic medical-rag-secrets \
  --from-literal=API_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=SENSENOVA_API_KEY="$SENSENOVA_API_KEY" \
  --from-literal=DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY"

# 2) 准备 KB 源（二选一）
#   (A) RWX PVC 方案：建 PVC + 跑构建 Job
kubectl apply -f k8s/kb-pvc.yaml
kubectl apply -f k8s/kb-build-job.yaml
kubectl -n medical-rag wait --for=condition=complete job/medical-rag-kb-build --timeout=600s
#   (B) 镜像内置方案：删 kb-source 卷与 initContainer 的 --src-dir，构建期已 npm run kb:rebuild

# 3) 应用工作负载
kubectl apply -f k8s/service.yaml -f k8s/ingress.yaml -f k8s/hpa.yaml
kubectl apply -f k8s/deployment.yaml

# 4) 观察
kubectl -n medical-rag get pods -w
kubectl -n medical-rag exec deploy/medical-rag-api -- curl -s localhost:8080/readyz
```

## 已知限制 / 后续

- **跨用户会话污染**：单 Pi 串行，同 Pod 多用户提示会进入同一 Pi 会话；生产靠会话亲和不跨 Pod 缓解。根治需 Pi 支持多实例/多会话（上游）。
- **优雅排水**：当前在途请求最多等 `API_DRAIN_MS`(30s)，超时被中断；长尾请求可结合更大 grace + 客户端重试。
- **自定义扩缩指标**：建议增补 ask p99 / 在途请求数（Prometheus Adapter）以更贴合容量。
