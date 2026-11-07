# Agent Medical Interpreter (AMI) · 医疗口译智能体演练台

基于多智能体的**医疗口译情景教学 Demo**。系统用 LLM 扮演医生、患者、口译员、评判员与管理者的角色，把一次完整的医患沟通自动演出来，并逐句给出量规化的口译质量评分与讲解材料。

面向医疗口译 / 医学英语专业的学生与教师，也用于收集人类评分与 AI 评分的对照数据。

---

## 目录

- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [配置项](#配置项)
- [目录结构](#目录结构)
- [系统架构](#系统架构)
- [三种演练模式](#三种演练模式)
- [智能体与提示词](#智能体与提示词)
- [评估量规](#评估量规)
- [知识库（MSD）](#知识库msd)
- [HTTP API](#http-api)
- [数据文件格式](#数据文件格式)
- [部署](#部署)
- [扩展指南](#扩展指南)
- [已知限制与待办](#已知限制与待办)
- [常见问题](#常见问题)

---

## 核心能力

| 能力 | 说明 |
|---|---|
| **三种演练模式** | 全自动演练（AI 对 AI）／用户扮演医生／用户扮演译员 |
| **五种临床场景** | 门诊诊治、复诊、预约挂号、检查检验咨询、行前注意事项 |
| **参数化患者** | 国家、语言、性别、年龄、性格、健康素养、宗教、饮食、文化禁忌、疾病、症状、既往症可配置或随机生成 |
| **医学知识注入** | 医生侧注入 MSD 诊疗手册专业版条目，患者侧注入 LLM 改写的通俗版，形成同病种双版本对照 |
| **量规化评分** | 依据 ISO 21998 十维框架扩展，三套量规（职业译员／双角色护士／医护英语），维度 1-5 分制，综合得分按百分制展示 |
| **双轨评分** | AI 评分 + 人工评分，可对比每句分差 |
| **剧本导出** | 一键导出结构化 `.docx`：演练设定、剧本正文、评估记录、演练报告、剧本讲解 |
| **语音合成与识别** | CosyVoice2 情感 TTS（角色音色）+ SenseVoice 语音转写，法语/西语等不支持的语种回退浏览器合成 |
| **标准病人预设** | 8 个 SP 病例一键填充，覆盖常见科室与文化情境 |
| **对话展示** | 单列时间线按话轮顺序排列，逐字流式输出，历史消息顶部渐隐 |
| **干跑模式** | 不调用 LLM 返回固定样例，用于不烧 token 的链路调试 |

---

## 快速开始

### 环境要求

- **Node.js ≥ 22**（仅使用内置模块，无 `npm install` 步骤）
- 一个 OpenAI 兼容协议的 LLM 服务（默认 OpenRouter）

### 1. 配置

```bash
cp .env.example .env
```

编辑 `.env`，填入 API Key：

```ini
AMI_BASE_URL=https://openrouter.ai/api/v1
AMI_MODEL=deepseek/deepseek-v4.1-flash
AMI_API_KEY=sk-or-v1-你的key
PORT=8790
DRY_RUN=0
```

> `.env` 已在 `.gitignore` 中，绝不会进仓库。Key 只存在于服务端，前端页面拿不到。

### 2. 启动

```bash
npm start          # 等价于 node server.mjs
```

打开 <http://127.0.0.1:8790>。

### 3. 先跑干跑模式（可选）

没有 API Key 也能验证前后端链路：

```bash
DRY_RUN=1 npm start
```

此时顶栏会出现黄色「干跑模式」徽章，所有智能体返回固定样例文本。

### 4. 运行测试

```bash
npm test
```

测试使用 Node 内置 test runner，全部在干跑模式下运行，**不消耗 LLM 额度**。覆盖：

- 评判员超长/故障时的降级重试与 0 分兜底
- 演练结束后导出的 docx 是否正确带上会话中的译员名

---

## 配置项

全部通过 `.env` 或环境变量传入，服务启动时加载一次（已存在的环境变量优先，不会被 `.env` 覆盖）。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AMI_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI 兼容 API 的 base URL |
| `AMI_MODEL` | `deepseek/deepseek-v4.1-flash` | 模型 ID |
| `AMI_API_KEY` | — | 必填（除干跑模式外）。缺失时所有请求返回 503 |
| `SILICONFLOW_API_KEY` | — | 语音服务 Key。缺失时朗读回退浏览器合成，语音输入不可用 |
| `PORT` | `8790` | 监听端口，必须在 1024–65535 之间 |
| `DRY_RUN` | `0` | `1` = 干跑，不调用 LLM |
| `BIND` | `127.0.0.1` | 监听地址。公网直连服务器时设 `0.0.0.0` |
| `ALLOWED_HOSTS` | 为空 | Host 头白名单，逗号分隔，支持三种写法（见下） |
| `RUBRIC_PUBLIC` | 空（等同 `0`） | `1` = 对访客开放量规读写；其他值 = 后台化，隐藏页面且接口返回 403 |

`ALLOWED_HOSTS` 写法：

| 写法 | 含义 | 适用 |
|---|---|---|
| `example.com:8790` | 精确匹配 | 固定 IP / 域名 |
| `.cpolar.top` | 任意子域名 | 隧道域名后缀稳定时 |
| `*` | 全部放行 | **仅限**本机监听 + 自有内网穿透客户端 |

无论是否配置，`localhost:PORT`、`127.0.0.1:PORT`、`[::1]:PORT` 始终放行。

> ⚠️ 使用 `BIND=0.0.0.0` 且 `ALLOWED_HOSTS=*` 时，API 无任何认证，任何扫到端口的人都能消耗你的额度。

---

## 目录结构

```
.
├── server.mjs                  # HTTP 入口：.env 加载、Host 校验、API 转发、静态资源
├── package.json                # 无依赖，"start" 与 "test" 脚本
├── DEPLOY.md                   # 公网部署教程（内网穿透 / 云服务器 / HTTPS）
├── .env.example                # 配置模板
│
├── src/
│   ├── api.mjs                 # 路由、会话管理、SSE、存档、docx 导出入口
│   ├── agents.mjs              # 五智能体内核（提示词 + 编排）
│   ├── llm.mjs                 # LLM 调用封装、JSON 解析、干跑样例
│   ├── scenarios.mjs           # 五种场景的配置状态机
│   ├── rubric.mjs              # 量规加载 / 编辑 / 持久化
│   ├── msd.mjs                 # MSD 手册检索与通俗版改写缓存
│   ├── docx.mjs                # 零依赖手写 OOXML 生成 .docx
│   ├── audio.mjs               # 硅基流动 TTS（CosyVoice2）/ ASR（SenseVoice）转发
│   ├── pools.mjs               # 患者参数池（国家/语言/宗教/饮食/疾病/标准病人预设…）
│   └── static.mjs              # 静态资源索引与 MIME 表
│
├── test/
│   ├── helpers.mjs             # 干跑模式启动服务端的测试工具
│   ├── judge-resilience.test.mjs   # 评判员降级重试
│   ├── judge-consistency.test.mjs  # 低分复核与温度校准
│   ├── rubric-gate.test.mjs    # 量规接口的开放/后台化开关
│   ├── m2-feedback.test.mjs    # 模式2 反馈与报告汇总
│   ├── msd-levels.test.mjs     # 知识库匹配级别
│   ├── msd-prompt.test.mjs     # 不同级别的提示词注入
│   ├── coverage.test.mjs       # 覆盖度脚本可运行
│   └── exchange.test.mjs       # docx 导出的字段一致性
│
├── scripts/
│   └── coverage.mjs            # 知识库覆盖度自检（npm run coverage）
│
├── public/
│   ├── index.html              # 单页应用
│   ├── app.js                  # 前端逻辑（SSE、逐句交互、量规编辑、TTS）
│   ├── styles.css              # 样式
│   └── av_*.svg / av_*.png     # 角色头像
│
└── data/
    ├── msd_diseases_final_new.json   # MSD 手册语料（24 主题）
    └── rubric.json                   # 当前量规存档（运行时会被前端改写）
```

运行时生成（均已被 `.gitignore` 排除）：

```
output/*.json                 # 每次演练的完整存档（对话/评分/设定/讲解）
src/.consumer_cache.json      # MSD 通俗版改写缓存
```

---

## 系统架构

```
浏览器 (public/)
   │  fetch JSON  /api/*
   ▼
server.mjs ── Host 白名单 ──► src/api.mjs ──► src/agents.mjs ──► src/llm.mjs ──► OpenRouter
   │                              │
   │                              ├─► src/scenarios.mjs   场景配置
   │                              ├─► src/rubric.mjs      量规（data/rubric.json）
   │                              ├─► src/msd.mjs         知识检索
   │                              └─► src/docx.mjs        docx 生成
   └── 静态文件 (public/)
```

- **零第三方依赖**：只用 `node:http`、`node:fs`、`node:path` 等内置模块。
- **前端零框架**：原生 DOM + `fetch`，SSE 用 `ReadableStream` 手工解析。
- **会话状态全在内存**：`Map<sessionId, {state, pending}>`，2 小时无活动自动清理。
- **导出档案**：`Map<exportId, record>`，只保留最近 30 份，重启即清空（落盘文件不受影响）。

### 请求链路

1. `server.mjs` 校验 Host 头与端口，大于 2 MB 的请求体直接 413。
2. `/api/*` 统一封装成标准 `Request` 交给 `apiFetch()`，响应再流式写回。
3. 静态资源走 `publicAssets()` 建立的白名单映射，不存在的路径直接 404（无目录遍历风险）。

---

## 三种演练模式

### 模式 1 · 智能体自动演练

AI 医生 ↔ AI 患者，AI 译员双向传译，评判员逐句评分。通过 **SSE** 流式推送，前端边收边渲染。

一轮的调用顺序：

```
管理者判断是否终止
   ↓
医生发言 ──► 译员译给患者 ──► 评判员打分
   ↓
患者发言 ──► 译员译给医生 ──► 评判员打分
   ↓
下一轮（或终止）
```

每轮约 7 次 LLM 调用；加上人设生成、通俗版改写（有缓存）与讲解生成，单次完整演练约 20 次调用。

SSE 事件类型：

| `type` | 载荷 | 含义 |
|---|---|---|
| `status` | `label` | 当前阶段文字提示 |
| `info` | `patientInfo` | 患者人设生成完毕 |
| `round` | `round` | 进入第 N 轮 |
| `message` | `round, speaker, lang, text, dir?` | 某角色说了一句话 |
| `score` | `round, for, score` | 本句评分结果 |
| `done` | `stopped, rounds, report, saved, exportId` | 演练结束 |
| `error` | `error` | 执行失败 |
| `end` | — | 流结束标记 |

### 模式 2 · 我扮演医生

用户直接用患者语言问诊，AI 扮演患者回应；系统按「医护英语沟通」量规逐句评分并给出改进建议。适合练习医护人员直接与外籍患者沟通的能力。

- 用户先开口，前端给出开场指引
- 每句提交后立即按「医护英语沟通」量规评分，并给出更地道的替代表达
- 结束后生成逐句表达对照与个性化提升方案
- 支持「参考建议」与主动结束
- 报告按 medstaff 量规汇总，不与口译量规混用

### 模式 3 · 我扮演译员

AI 医生与 AI 患者轮流说话，用户逐句提交译文。

- 译文提交后立即 AI 评分，并推进到下一话轮
- 「参考建议」按钮给出参考译文，以及术语、地道句型、医学常识、流程说明四个角度（计次，报告里会显示使用次数）
- 三种评分方式：`ai`（仅 AI）／`dual`（AI + 人工）／`human`（仅人工，不调 AI 评委）
- 结束后生成逐句参考译文对照与个性化提升方案
- 结束后可逐句填 1–5 分人工评分，与 AI 分数对照并写入档案

---

## 智能体与提示词

全部位于 `src/agents.mjs`，均由 `src/llm.mjs` 统一调用。

| 智能体 | 函数 | 职责 |
|---|---|---|
| 患者人设生成器 | `makePatientInfo` | 按参数池生成患者小传；用户已给的字段优先，缺失部分由 LLM 补齐 |
| 医生 / 前台 | `doctorTurn` | 按场景人设问诊并给出诊断与方案；首轮注入 MSD 专业版资料 |
| 患者 | `patientTurn` | 以患者母语口语化描述症状；首轮注入 MSD 通俗版 |
| 口译员 | `interpreterTurn` | 双向口译；首次接触患者时先自我介绍再翻译 |
| 评判员 | `judgeTurn` | 按量规逐维打分（1–5），温度 0；低于 60 分时补采两次取中位数 |
| 医护沟通评分 | `judgeMedStaff` | 模式 2 专用：评价医生本人的外语表达并给替代表达 |
| 管理者 | `managerCheck` | 判定对话是否应终止（`TERMINATE` / `CONTINUE`），容错重试 2 次 |
| 讲解生成 | `genTeaching` | 产出医学知识、诊疗流程、术语、语言难点四部分 |
| 参考建议 | `genReference` / `genM2Hint` | 用户卡住时给出参考译文 + 术语/句型/医学/流程四角度 |
| 个性化反馈（模式 3） | `genPersonalFeedback` | 结束后生成逐句参考译文与提升方案 |
| 个性化反馈（模式 2） | `genDoctorFeedback` | 结束后生成医生表达对照与提升方案 |

### 终止机制

三重保险：

1. 医生 / 患者智能体自身输出 `TERMINATE`（结尾匹配，避免正文误伤）
2. 管理者智能体在每轮开始前判定 `TERMINATE`
3. 达到轮数上限（模式 1 前端可选 2/4/6/10/30，默认 30；模式 3 默认 30 轮即 60 个半话轮；模式 2 默认 12 句）。上限只作兜底，正常应以对话自然结束为准

### 视角隔离

每个智能体只看到自己「应该看到」的对话：

- 医生看到自己的原话 + 译回医生语言的译文，**看不到**患者母语原话
- 患者看到自己的原话 + 译给患者的译文（模式 2 中直接看到医生的话）
- 口译员看到全部

这是模拟真实口译场景中信息不对称的关键设计。

---

## 评估量规

默认量规参考 **ISO 21998:2021** 十维框架，并按译员类型扩展。存于 `data/rubric.json`，前端「量规编辑」页可直接改，保存后立即影响后续评分。

### 三套量规

| ID | 名称 | 适用 | 维度数 |
|---|---|---|---|
| `professional` | 职业医疗口译员 | 模式 1 / 3 | 11（十维 + 伦理决策） |
| `dual` | 双角色护士（口译） | 模式 1 / 3 | 11（十维 + 双重角色平衡） |
| `medstaff` | 医护英语沟通（医生） | 模式 2 | 6（语言 / 沟通 / 态度） |

### 十维基础框架

| 组 | key | 名称 | 关注点 |
|---|---|---|---|
| 准确度 | `accuracy_medical_knowledge` | 医学术语与知识保真 | 术语是否准确，医学概念是否失真 |
| 准确度 | `accuracy_information_integrity` | 信息完整性 | 漏译、增译、曲解，数字剂量是否保真 |
| 口译技巧 | `technique_discourse_management` | 对话管理 | 话轮处理、长段切分、必要的澄清与重复 |
| 口译技巧 | `technique_use_of_person` | 人称运用 | 是否始终第一人称 |
| 口译技巧 | `technique_cultural_interpretation` | 文化与概念诠释 | 跨文化差异是否被自然协调 |
| 职业伦理 | `ethics_role_boundaries` | 角色边界 | 有无越界给医疗建议、虚假安慰 |
| 职业伦理 | `ethics_impartiality` | 中立性 | 是否中立传递双方 |
| 沟通有效性 | `effectiveness_trust_building` | 促进理解与信任 | 患者是否听得懂 |
| 沟通有效性 | `effectiveness_fluency` | 效率与流畅度 | 表达是否自然、简洁 |
| 同理心 | `empathy_expression` | 体现与传达情感 | 情感语气是否被传递 |

### 三档行为锚点

- **1–2 分**：术语错误、信息遗漏或增减、人称混乱、角色越界、虚假承诺等明显问题
- **3 分**：信息基本完整准确，无重大错误，但表达平淡或略冗余
- **4–5 分**：术语保真、信息完整、人称统一、文化协调自然，体现患者赋权与人文关怀

各维度保留 1–5 分制，报告与剧本中的综合得分统一折算为百分制（维度场均分 ÷ 5 × 100），便于横向比较。

### 评分稳定性

评判链路上有三层约束：

1. **温度 0**：同一条译文重复评分的结果尽量一致
2. **低分复核**：首次得分低于 60 分时补采两次，按维度取中位数，抑制单次异常打分；正常分数不增加调用
3. **失败降级**：超长或临时故障时压缩输出重试一次，仍失败记 0 分并继续演练

实测同一批 23 句样本，校准后 5 分占比从 78% 降到 66%，4 分从 16% 升到 27%。

### 编辑与重置

- 前端「量规编辑」页：可改行为锚点、人设要点、维度增删（3–20 个），`key` 须匹配 `^[a-z][a-z0-9_]{1,39}$` 且不重复
- 删除 `data/rubric.json` 并重启即恢复默认量规

---

## 知识库（MSD）

`data/msd_diseases_final_new.json` 是 MSD 诊疗手册语料，三层结构：

```json
{
  "泌尿生殖系统疾病": {
    "泌尿生殖系统疾病的症状": {
      "尿频": "……正文……"
    }
  }
}
```

共 24 个主题、2519 条条目。检索为关键词加权子串匹配：标题 +6（完全相等 +9）、子主题 +4、主题 +2、正文 +1；总分低于 4 的纯正文命中会被丢弃。

### 匹配级别

`search()` 返回 `{level, hits}`，让智能体知道这批资料是什么性质：

| level | 含义 | 医生侧处理 |
|---|---|---|
| `disease` | 命中该疾病专条（含别名映射） | 可直接作为诊断与治疗参考 |
| `related` | 只命中相关症状/检查条目 | 只可作背景参考，不得当作疾病诊疗依据 |
| `none` | 未收录 | 明确告知未收录，不得声称引用手册或编造内容 |

`related` / `none` 时，系统提示词会常驻一条约束，避免模型把症状页当成疾病指南。

### 覆盖度自检

```bash
npm run coverage            # 列出每个疾病的匹配级别
npm run coverage -- --strict  # 有缺口时退出码 1，可用于上线前检查
```

当前结果：**10/12 有疾病专条**；`肾结石` 只有相关条目，`脾阳虚` 属中医、手册无对应条目。

### 两种用法

- **专业版**：医生首轮检索，原文片段注入提示词
- **通俗版**：患者首轮检索后由 LLM 改写为无医学背景也能听懂的口语化解释，结果按标题缓存在 `src/.consumer_cache.json`。只有 `disease` 级别才会把条目当作该病科普，`related` 直接使用通用科普兜底

预约挂号场景不检索知识库（`msdSearch: false`）。

---

## HTTP API

所有接口返回 JSON；错误统一为 `{"error": "..."}`，并带对应状态码。

### 配置与量规

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| GET | `/api/config` | — | 模型名、干跑标志、场景列表、译员类型、全部参数池 |
| GET | `/api/rubric` | — | 当前完整量规存档。`RUBRIC_PUBLIC!=1` 时返回 403 |
| POST | `/api/rubric/save` | `{persona, personaNote[], dims[]}` | 保存某套量规。`RUBRIC_PUBLIC!=1` 时返回 403 |
| POST | `/api/rubric/reset` | — | 恢复默认量规。`RUBRIC_PUBLIC!=1` 时返回 403 |

### 模式 1

| 方法 | 路径 | 请求体 |
|---|---|---|
| POST | `/api/auto` | `{scenario, interpreterType, params, maxRounds}` |

响应为 **SSE**（`text/event-stream`），事件见[模式 1](#模式-1--智能体自动演练)。

### 模式 3

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| POST | `/api/drill/start` | `{scenario, interpreterType, scoringMode, params}` | 返回 `sessionId`、患者信息、医生开场、维度列表 |
| POST | `/api/drill/step` | `{sessionId, translation}` | 提交一句译文；返回评分与下一句 |
| POST | `/api/drill/hint` | `{sessionId}` | 返回当前应说的参考译文 |
| POST | `/api/drill/finish-score` | `{exportId, scores:[{half, score, comment}]}` | 提交人工评分 |

### 模式 2

| 方法 | 路径 | 请求体 |
|---|---|---|
| POST | `/api/m2/start` | `{scenario, params}` |
| POST | `/api/m2/turn` | `{sessionId, utterance}` |
| POST | `/api/m2/hint` | `{sessionId}` |
| POST | `/api/m2/finish` | `{sessionId}` |

### 语音

| 方法 | 路径 | 请求 | 说明 |
|---|---|---|---|
| POST | `/api/tts` | `{text, lang, role, gender?}` | 返回 `audio/mpeg`。`role` 决定音色（doctor / patient / interpreter）；中英日韩走 CosyVoice2，其他语种返回 400 由前端回退 |
| POST | `/api/asr` | `multipart/form-data`，字段 `file` | 返回 `{text}`，服务端转发 SenseVoice |

> 两个接口都需要 `SILICONFLOW_API_KEY`，缺失时返回 503。

### 导出

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/export/{exportId}` | 下载 `.docx` 剧本 |

> `/api/doctor/*` 为历史遗留路径，固定返回 501，请使用 `/api/m2/*`。

### `params` 字段

| 字段 | 说明 |
|---|---|
| `disease` | 疾病名，默认「肾结石」 |
| `country` / `language` | 患者国家与语言，留空按国家池随机 |
| `name` / `age` / `gender` | 患者基本信息，留空随机 |
| `personality` | 焦虑 / 急躁 / 平和 / 谨慎多问 / 开朗 |
| `healthLiteracy` | 健康素养水平 |
| `religion` / `diet` / `taboos` | 宗教、饮食、文化禁忌 |
| `symptoms` / `medicalHistory` | 留空则由 LLM 按疾病生成 |
| `department` | 医生科室（预约挂号场景忽略），可选 34 个临床科室 |
| `doctorLanguage` | 医生使用语言（中文 / 英语） |

`GET /api/config` 的 `paramOptions.presets` 提供 8 个标准病人预设，字段与上表一致，前端可一键填充后继续手改。

### 评分对象结构

```json
{
  "original_words": "医生原话",
  "translated_words": "口译译文",
  "accuracy_medical_knowledge": 4,
  "...": "各维度 1-5 分",
  "total": 43,
  "perfect": 55,
  "percent": 78,
  "comment": "一句话总评",
  "key_point": "面向学习者的一条语言服务要点"
}
```

`total` / `perfect` 是维度分累加，`percent` 是统一展示用的百分制（`total ÷ perfect × 100`）。

### 报告结构

```json
{
  "utterances": 8,
  "totalAvg": 4.05,
  "perDim": [{"key": "...", "group": "...", "label": "...", "focus": "...", "avg": 4.1}],
  "comments": ["..."],
  "keyPoints": ["..."],
  "human": {"count": 3, "avg": 4.0, "items": []}
}
```

`human` 仅在有主观评分时出现。

---

## 数据文件格式

### 落盘存档 `output/*.json`

文件名：`{scenario}_{interpreterType}_{mode}_{YYYYMMDDHHmmss}.json`

```json
{
  "settings": { "mode": "auto", "scenario": "consult", "interpreterType": "professional", "params": {}, "maxRounds": 4 },
  "patientInfo": { "name": "Michael Brown", "age": 50, "country": "美国", "disease_info": {} },
  "doctor": { "name": "张医生", "roleLabel": "医生", "specialization": "泌尿外科" },
  "log": [{ "role": "doctor", "content": "..." }],
  "scores": [],
  "humanScores": [],
  "hintUsed": 0,
  "msdRefs": [],
  "consumerPlain": "",
  "teaching": {},
  "rounds": 4,
  "report": {}
}
```

字段缺失时按空值处理，可直接用于离线分析。

---

## 部署

完整的公网部署教程（内网穿透、云服务器、Caddy HTTPS、上线检查清单）见 **[DEPLOY.md](DEPLOY.md)**。

要点：

- 公网部署前务必：单独申请 Key、在 OpenRouter 与硅基流动分别设置消费上限、关闭 `DRY_RUN`、保持 `RUBRIC_PUBLIC=0`
- 录音（`getUserMedia`）只在 **HTTPS 或 localhost** 下可用
- 单进程串行调用 LLM，2–3 人同时使用无压力，更多并发会排队

---

## 扩展指南

### 新增一个临床场景

1. 在 `src/scenarios.mjs` 的 `SCENARIOS` 中追加一个对象，字段参照 `consult`：

   | 字段 | 作用 |
   |---|---|
   | `id` / `name` | 内部标识与显示名 |
   | `implemented` | 为 `false` 时前端下拉框置灰 |
   | `roleLabel` | 对方角色名（医生 / 前台护士…） |
   | `doctorName` / `department` | 默认人名与是否使用配置面板的科室 |
   | `msdSearch` | 是否检索 MSD 知识库 |
   | `doctorRoleText` | 系统提示词主体，可用 `{dept}` `{name}` 占位 |
   | `terminateNote` | 医生侧的终止条件说明 |
   | `patientNote` | 注入患者提示词的目标说明 |
   | `managerConditions` | 管理者判定终止的条件 |
   | `doctorOpening` | 首轮追加的开场指令 |
   | `doctorGoals` / `keyPoints` | 流程阶段展示与话术提示 |

2. 前端会通过 `GET /api/config` 自动读取场景列表，**不需要改 HTML**。

3. 两处硬编码需要同步：

   - `src/docx.mjs:99` 的 `scenarioNames` 映射，漏了的话 docx 标题会直接显示场景 id
   - `public/app.js` 的头像判定只特判了 `前台护士`，新角色类型需要在这里补分支

### 新增或修改评估维度

- **最省事**：用前端「量规编辑」页改，保存即生效，无需重启
- **改默认值**：编辑 `src/rubric.mjs` 的 `BASE_DIMS`（或某个 persona 的 `dims`）
- 维度 `key` 必须匹配 `^[a-z][a-z0-9_]{1,39}$`，同一套量规内不能重复
- ⚠️ `data/rubric.json` 存在时会**完全覆盖**代码里的默认值。改完 `rubric.mjs` 必须删掉该文件再重启，否则看不到变化

### 更换模型

改 `.env` 的 `AMI_MODEL` 即可，但模型需要满足两点：

1. 支持 OpenAI 兼容的 `response_format: {"type": "json_object"}`，否则评分解析会失败
2. 能接受请求体里的 `reasoning: {"enabled": false}`（`src/llm.mjs:95` 硬编码）；若服务端拒绝未知字段，需要去掉这一项

### 扩充患者参数池

- 国家、语言、姓名、宗教、饮食、禁忌、性格、疾病示例：`src/pools.mjs`
- 科室：同文件 `DEPARTMENTS`
- 注意 `COUNTRIES` 里的 `language` 必须出现在 `LANGUAGES` 中，否则前端的国家→语言联动不生效

### 扩充医学知识库

`data/msd_diseases_final_new.json` 按 `主题 → 子主题 → 标题 → 正文` 组织。检索权重为：标题命中 +6（完全相等 +9）、子主题 +4、主题 +2、正文 +1，**总分低于 4 的纯正文命中会被丢弃**。所以：

- 只把内容写进正文，疾病名不出现在标题或子主题里，检索会直接判为噪声
- 把常见病单独开一条 title（哪怕正文较短）就能显著提升召回质量
- 简称与手册病名不一致时，在 `src/msd.mjs` 的 `EXPANSIONS` 里补映射：
  - `aliases`：同一种疾病的别名，命中标题即视为「疾病专条」
  - `terms`：症状、检查等相关词，只用于召回，不会提升匹配级别
- 补完语料后运行 `npm run coverage` 确认缺口是否补齐

---

## 已知限制与待办

**架构层面**

- 会话与导出档案全部在内存，重启即丢失；不支持多实例横向扩展
- LLM 调用串行执行，高并发下响应会排队
- 无持久化存储，`output/*.json` 是唯一落盘记录
- 无 lint、无 CI

**安全层面**

- `/api/*` 无任何认证，只能靠 Host 白名单 + 部署侧网络隔离
- 前端多处用 `innerHTML` 拼接模型输出与用户译文（`public/app.js`），公网部署前应做转义或改用 `textContent`
- 单次请求体上限 2 MB，无速率限制

**功能层面**

- `data/rubric.json` 被前端改写后仍是仓库内文件，多人部署时会互相覆盖
- 患者参数池（国家/姓名/疾病）为硬编码，扩充需改 `src/pools.mjs`
- 通俗版改写缓存按标题缓存，医学内容更新后需手动删缓存
- 评分仍有高位聚集：校准后 5 分占比约 66%，4 分与 5 分的边界还需结合真实语料继续调整
- 语音只覆盖中/英/日/韩，法语与西班牙语走浏览器合成；ASR 对中文专名识别不稳定

---

## 常见问题

**403 Forbidden**
Host 头不在白名单。隧道域名的 Host 是纯域名（不带 `http://`、不带端口），写 `域名`、`.后缀` 或 `*`。

**ENOTFOUND '127.0.0.1'**
`.env` 的值带了多余的成对引号。加载器已做剥引号容错，更新代码后重启即可。

**干跑模式徽章一直显示**
`DRY_RUN=1` 未关闭，或 `.env` 没有被正确加载（检查文件是否在项目根目录）。

**🎤 语音按钮无效**
录音依赖 `getUserMedia`，浏览器只在 HTTPS 或 localhost 下允许调用。另外需配置 `SILICONFLOW_API_KEY`，否则识别会返回 503。

**朗读没有声音或很机械**
先看是否配置了 `SILICONFLOW_API_KEY`；未配置时回退浏览器合成，音色取决于系统。法语、西班牙语始终走浏览器回退。

**评分一直是 0 分**
模型未按 JSON 格式返回。`parseJSON` 会先剥离 ```json 代码围栏，评分调用失败时会压缩输出重试一次，仍失败则记 0 分并继续演练（不会中断）。可换模型或在提示词中加强约束。

**看不到「量规编辑」页**
`RUBRIC_PUBLIC` 不为 `1` 时量规已后台化，页面隐藏且接口返回 403。这是对外部署的默认行为，本地调试时在 `.env` 里临时改成 `1`。

**量规改坏了**
删除 `data/rubric.json` 重启，恢复默认。

---

## License

仓库暂未声明开源许可证。
