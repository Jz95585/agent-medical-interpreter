# AMI Demo 公网部署教程

本教程面向"让其他人通过公网访问并体验 AMI 演练台"的场景。两种方式：内网穿透（最快）与云服务器（正式）。部署前先完成第 0 步的安全配置。

---

## 第 0 步：安全配置（必做）

公网部署 = 陌生人共用你的 API 额度。四件事按顺序做：

1. **申请两把独立 Key**
   - OpenRouter：<https://openrouter.ai/keys>，用于所有对话、评分与讲解
   - 硅基流动：<https://cloud.siliconflow.cn/account/ak>，用于语音合成与识别
   - 两把 key 都只给本 demo 用，不要复用其他项目的 key
2. **设消费上限**：OpenRouter → Keys → Credit Limit（如 $5）；硅基流动账户注意代金券余额
3. **确认运行模式**：`DRY_RUN=0`（真实演练）
4. **关闭量规对访客开放**：`RUBRIC_PUBLIC=0`

### 部署相关的 .env 配置项

```ini
# LLM（必填）
AMI_BASE_URL=https://openrouter.ai/api/v1
AMI_MODEL=deepseek/deepseek-v4.1-flash
AMI_API_KEY=sk-or-v1-xxxx

# 语音（语音输入与自然音色朗读必填；缺失时朗读回退浏览器合成、语音输入不可用）
SILICONFLOW_API_KEY=sk-xxxx

# 服务
PORT=8790
BIND=127.0.0.1         # 本机隧道用 127.0.0.1；云服务器直接暴露用 0.0.0.0
ALLOWED_HOSTS=...      # Host 头白名单（见下）

DRY_RUN=0
RUBRIC_PUBLIC=0        # 0 = 量规后台运行，访客看不到也调不到
```

`ALLOWED_HOSTS` 支持三种写法（逗号分隔可混用）：

| 写法 | 匹配 | 适用 |
|---|---|---|
| `host:port` | 精确匹配 | 云服务器固定 IP/域名 |
| `.后缀` | 任意子域名（如 `.cpolar.top`） | 隧道域名后缀稳定时 |
| `*` | 全部 | **仅限"本机服务 + 内网穿透"**：服务只监听 127.0.0.1，外网流量必须经过你自己的隧道客户端，Host 校验无实际防护意义 |

> ⚠️ 迁到云服务器使用 `BIND=0.0.0.0` 时，务必把 `*` 改回精确域名，否则任何人扫到端口即可消耗你的额度。

> `.env` 只存在于服务端，已在 `.gitignore` 中。环境变量优先于 `.env`，两者不一致时以环境变量为准。

---

## 方式 A：内网穿透（最快，本机运行）

适合快速收集反馈。你的电脑运行服务，隧道工具把公网流量转进来。

### 以 cpolar 为例（国内直连）

1. [cpolar 官网](https://www.cpolar.com/) 注册并安装客户端
2. 启动服务（本机监听即可，不需要 0.0.0.0）：
   ```bash
   npm start
   ```
3. 另开终端启动隧道：
   ```bash
   cpolar http 8790
   ```
4. cpolar 会显示一个公网地址（如 `http://2d3ac7e9.r18.cpolar.top`），发给测试者即可
5. `.env` 中设置 `ALLOWED_HOSTS=*`，重启服务

**优点**：5 分钟上线。**缺点**：本机开机才可用；免费版域名随机变化、有带宽限制。

Cloudflare Tunnel 同理（`cloudflared tunnel --url http://127.0.0.1:8790`），免费但国内访问速度不稳定。

### 排错备忘

- **403 Forbidden**：Host 头不在白名单。隧道域名的 Host 头是**纯域名**（不带 `http://`、不带端口），写 `域名` 或 `.后缀` 或 `*`
- **ENOTFOUND '127.0.0.1'**：`.env` 值带了多余引号。加载器会自动剥离成对引号，更新代码后重启即可
- 隧道域名变化后无需改配置（`*` 或后缀写法已覆盖）

---

## 方式 B：轻量云服务器（正式，反馈期推荐）

1. **购机**：腾讯云/阿里云轻量应用服务器 2核2G 即可（约 ¥50-90/月）。
   - 香港/海外节点：**免备案**，国内延迟略高
   - 国内节点：绑定域名需 ICP 备案；仅用 `IP:端口` 访问可不备案但无法上 HTTPS
2. **装环境**（Ubuntu，Node 需 ≥ 22）：
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm i -g pm2
   ```
3. **拉代码**：
   ```bash
   git clone https://github.com/Jz95585/agent-medical-interpreter.git
   cd agent-medical-interpreter
   ```
   项目没有第三方依赖，**不需要 `npm install`**。`.env` 在服务器上手动创建，内容见第 0 步。
4. **先自检，再启动**：
   ```bash
   npm test                 # 干跑模式，不消耗额度
   npm run coverage         # 知识库覆盖度，查看缺口
   ```
5. **启动并守护进程**：
   ```bash
   BIND=0.0.0.0 ALLOWED_HOSTS=服务器IP:8790 pm2 start server.mjs --name ami
   pm2 save && pm2 startup    # 开机自启
   ```
   > `BIND` / `ALLOWED_HOSTS` 也可以直接写进服务器上的 `.env`，两种方式任选其一。
6. **防火墙**：云控制台安全组放行 TCP 8790
7. **访问**：`http://服务器IP:8790`

### 更新已部署的版本

```bash
cd agent-medical-interpreter
git pull
pm2 restart ami
```

拉取前先处理两件事：

- **检查 `.env`**：新增配置项 `SILICONFLOW_API_KEY`、`RUBRIC_PUBLIC=0` 是否已补
- **检查 `data/rubric.json`**：如果之前有人在网页上改过量规，这个文件会被改写，`git pull` 会冲突。先备份再恢复默认：
  ```bash
  cp data/rubric.json /tmp/rubric.backup.json
  git checkout -- data/rubric.json
  ```

### HTTPS（强烈建议）

浏览器只在 **HTTPS 或 localhost** 下允许录音（`getUserMedia`）。公网 HTTP 访问时 🎤 按钮不可用，朗读不受影响。最省事的方案是 Caddy（自动申请续期证书）：

```bash
sudo apt install caddy
sudo nano /etc/caddy/Caddyfile
```

```
你的域名 {
    reverse_proxy 127.0.0.1:8790
}
```

然后 `.env` 中 `ALLOWED_HOSTS` 加上你的域名（走 Caddy 反代时 Host 头为纯域名，不带端口），`pm2 restart ami`。

---

## 版本确认

部署后不必登录服务器，直接看接口即可判断代码是否生效：

```bash
curl -s http://服务器地址/api/config
```

| 返回字段 | 说明 |
|---|---|
| `paramOptions.presets` 长度为 8 | 标准病人预设已生效 |
| `rubricPublic` 为 `false` | 量规已后台化（新版本默认） |
| `dryRun` 为 `false` | 真实调用模式 |
| `POST /api/tts` 返回 200 | 语音服务已配置 |

如果 `presets` 不存在，说明服务器仍是旧版本。

---

## 运行期注意事项

| 事项 | 说明 |
|---|---|
| 会话清理 | 演练中断的会话 2 小时无活动自动释放（内存） |
| 导出档案 | 服务器内存保留最近 30 份，重启即清空；`output/*.json` 落盘存档不受影响 |
| 并发 | 单进程串行调 LLM，2-3 人同时使用无压力；更多并发会排队变慢 |
| 反馈素材 | 每次演练自动落盘 `output/*.json`（对话/评分/设定/讲解），定期打包拉回本地分析 |
| Token 消耗 | 每轮约 7 次 LLM 调用，上下文随对话持续增长；一场 10 轮的输入量在数万 token 量级，以 OpenRouter 后台统计为准 |
| 评分稳定性 | 单项低于 60 分时会补采两次取中位数，低分会话比正常会话多 2 次调用 |
| 量规 | 已后台化，访客不可见。需要调整时在服务器上直接改 `data/rubric.json` 或临时设 `RUBRIC_PUBLIC=1` |
| 数据字段 | 存档包含 `msdLevel`（disease / related / none），可用于统计知识库覆盖情况 |

---

## 上线验证清单

- [ ] 手机流量（非同一 WiFi）打开链接能访问
- [ ] 顶栏**无**"干跑模式"黄色徽章（有 = DRY_RUN 没关）
- [ ] `/api/config` 返回 `rubricPublic: false` 和 8 个预设病人
- [ ] 直接访问 `/api/rubric` 返回 403
- [ ] 跑一轮模式 1 自动演练，对话与评分正常，报告显示百分制
- [ ] 模式 2 提交一句，报告分数不为 0，结束时有逐句表达反馈
- [ ] 模式 3 提交一句译文，评分卡出现，参考建议有四个角度
- [ ] 下载 docx 成功，剧本文首的译员名不是「口译员」
- [ ] HTTPS 部署时：🎤 语音按钮能录音并识别
- [ ] OpenRouter 与硅基流动后台确认消费上限 / 余额已设置
