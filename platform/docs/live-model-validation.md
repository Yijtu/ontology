# 真实模型与 JEV 端点的实机验证（LOCAL-051 / S17）

本文件说明如何对**真实公司生成模型端点**与**真实 JEV 决策端点**做一次操作员手动的实机验证，以及如何阅读结果。它属于 SPEC §11 的 external-condition 任务：**不属于 CI**，CI 继续使用确定性替身（fake generation / FakeDecisionPort），不需要任何真实密钥。

## 结论速览（本次实机运行）

| 项 | 结果 | 说明 |
|---|---|---|
| 公司生成端点可达性 | **validated** | HTTP 200、`text/event-stream` |
| 实际模型版本 | **validated** | `deepseek-v4-1-flash-260910` |
| 自然语言回答字段 | **validated** | 原始 wire 探针取到非空 `content` |
| 结构化输出字段 | **validated** | `response_format=json_object`，返回可解析 JSON，`answer`/`confidence` 字段通过 |
| 工具调用字段 | **validated** | 返回 `function.name=data_query` 与流式 `arguments`，聚合后为合法 JSON |
| 延迟 / 用量 | **validated** | 见报告 `endpointProbes[].latencyMs` 与 `usage` |
| 经平台 `GenerationPort` 适配器调用 | **blocked（真实原因）** | 该网关为 OpenAI 兼容协议（`/v1/chat/completions`，`chat.completion.chunk`），而 `@ontology/adapter-model-company` 的 vendor 协议是自定义 `{type:"text_delta"|...}`；见下文“协议差距” |
| JEV 决策端点 | **blocked（真实原因）** | `ONTOLOGY_JEV_BASE_URL` 与 `ONTOLOGY_JEV_ENDPOINT` 均为空；仅有 api key 不构成通过 |

报告默认写到 `platform/tests/e2e/artifacts/live-model-validation.json`（该目录已被 `.gitignore` 忽略，不会提交）。报告只记录变量**名称**与存在/为空，绝不记录密钥值。

## 运行方式

```powershell
cd platform
pnpm exec tsx scripts/validate-live-models.mjs `
  --env-file="$ONTOLOGY_SECRETS_FILE" `
  --out="tests/e2e/artifacts/live-model-validation.json"
```

- `--env-file=<path>` 或环境变量 `ONTOLOGY_SECRETS_FILE` 指向操作员自备的密钥文件。**该路径由操作员提供，不属于仓库配置**，也不得写进提交的文件或产品代码。也可用 Node 的 `--env-file` 机制（Node 20+）。
- `--model-role=vendor-first|platform-first`（默认 `vendor-first`）：解释 `ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS` 的 `左=右` 方向。
- `--jev-vendor-model=<id>`：当 JEV 端点已配置时，指定 JEV 的 vendor 模型名。

## 环境变量契约（只按名称引用）

| 变量 | 用途 |
|---|---|
| `ONTOLOGY_COMPANY_MODEL_BASE_URL` | 公司生成网关基址 |
| `ONTOLOGY_COMPANY_MODEL_ENDPOINT` | 生成路径（相对/绝对均可，脚本会保留 base 的路径前缀） |
| `ONTOLOGY_COMPANY_MODEL_API_KEY` | 公司模型凭据（仅经 `SecretResolver` 解析） |
| `ONTOLOGY_COMPANY_MODEL_VENDOR_MODELS` | `vendorModel=platformModelId`（或 JSON / 逗号分隔）映射 |
| `ONTOLOGY_JEV_BASE_URL` | JEV 网关基址（本次为空 → blocked） |
| `ONTOLOGY_JEV_ENDPOINT` | JEV 路径（本次为空 → blocked） |
| `ONTOLOGY_JEV_API_KEY` | JEV 凭据 |

凭据只通过 `apps/api/src/composition/secret-resolver.ts` 的 `createEnvSecretResolver()`（`SecretResolver` 端口）解析：`secretRef` 是变量**名**（`env:ONTOLOGY_COMPANY_MODEL_API_KEY`），解析结果包在不可序列化的 `SecretValue` 中，隐式字符串/JSON 转换均为 `[redacted]`；缺失或为空时抛出带类型的 `SecretResolutionError`。产品代码与提交的配置中不出现密钥值，也不硬编码密钥文件绝对路径。

## 结果分类（三种，互不混淆）

- `validated`：固定请求确实到达真实端点并产出了记录的字段。
- `blocked`：外部条件不满足（缺端点、网络不可达、凭据被拒、协议不兼容），记录**真实原因**，不伪造结果。
- `error`：请求到达端点但失败，记录分类后的错误码。

## 协议差距（公司适配器，如实记录）

本次提供的网关是 **OpenAI 兼容**的（`https://<host>/v1` + `/chat/completions`），SSE 载荷为 `chat.completion.chunk`：

- 文本：`choices[].delta.content`（本适配器期望 `{type:"text_delta",text}`）。
- 工具调用：`choices[].delta.tool_calls[]`，首个分片带 `id`（形如 `call_00_...`，**不是 canonical UUID**）与 `function.name`，后续分片只带 `index` 与 `function.arguments` 增量（本适配器要求每个 `tool_call_delta` 同时携带 UUID `call_id` 与 `tool`）。
- 用量/结束：`usage` 与 `choices[].finish_reason`。

要让 `GenerationPort` 适配器直接消费该协议，需要修改其 vendor 解码与 `tool_call_delta` 的语义（放宽 UUID call id、跨分片累积）。本卡明确要求**不改变模型适配器的契约与语义**，因此未改动适配器：适配器层调用如实记录为 `INTERNAL_ERROR: the provider stream contained an unrecognised chunk`（工具调用另记录网关返回的 400 `INVALID_ARGUMENT`）。端点字段本身由上面的 wire 探针验证通过。

## CI 保持无密钥

- `pnpm run verify`（lint + typecheck + test）不读取任何真实密钥，全部通过。
- 单元测试 `tests/unit/secret-resolver.spec.ts` 只用假值，验证：按名解析、缺失/为空抛带类型错误、值不进入错误/日志/序列化输出。
- `tests/unit/live-report.spec.ts` 验证报告只含名称与存在性、映射解析、脱敏与分类。
- 真实端点验证只在操作员手动执行 `scripts/validate-live-models.mjs` 时发生。

## 安全提示

本次使用的 `ONTOLOGY_COMPANY_MODEL_API_KEY` 与 `ONTOLOGY_JEV_API_KEY` **已在此前聊天中以明文出现过**。建议在完成验证后**轮换这两个密钥**。
