# AMI Demo 公网部署教程

本教程面向"让其他人通过公网访问并体验 AMI 演练台"的场景。两种方式：内网穿透（最快）与云服务器（正式）。部署前先完成第 0 步的安全配置。

---

## 第 0 步：安全配置（必做）

公网部署 = 陌生人共用你的 API 额度。三件事按顺序做：

1. **换独立 key**：到 [OpenRouter](https://openrouter.ai/keys) 新建一把 key **只给本 demo 用**，替换 `project_new/.env` 中的 `AMI_API_KEY`
2. **设消费上限**：OpenRouter → Keys → 给该 key 设置 Credit Limit（如 $5），烧完自动停，损失可控
3. **确认运行模式**：`DRY_RUN=0`（真实演练）

### 部署相关的 .env 配置项

```ini
PORT=8790              # 服务端口
BIND=127.0.0.1         # 监听地址：本机隧道用 127.0.0.1；云服务器直接暴露用 0.0.0.0
ALLOWED_HOSTS=...      # Host 头白名单（见下）
```

`ALLOWED_HOSTS` 支持三种写法（逗号分隔可混用）：

| 写法 | 匹配 | 适用 |
|---|---|---|
| `host:port` | 精确匹配 | 云服务器固定 IP/域名 |
| `.后缀` | 任意子域名（如 `.cpolar.top`） | 隧道域名后缀稳定时 |
| `*` | 全部 | **仅限"本机服务 + 内网穿透"**：服务只监听 127.0.0.1，外网流量必须经过你自己的隧道客户端，Host 校验无实际防护意义 |

> ⚠️ 迁到云服务器使用 `BIND=0.0.0.0` 时，务必把 `*` 改回精确域名，否则任何人扫到端口即可消耗你的额度。
> `.env` 值支持手写成对引号（自动剥离）；`AMI_API_KEY` 只存在于服务端，前端页面拿不到。

---

## 方式 A：内网穿透（最快，本机运行）

适合快速收集反馈。你的电脑运行服务，隧道工具把公网流量转进来。

### 以 cpolar 为例（国内直连）

1. [cpolar 官网](https://www.cpolar.com/) 注册并安装客户端
2. 启动服务（本机监听即可，不需要 0.0.0.0）：
   ```powershell
   cd project_new
   npm start
   ```
3. 另开终端启动隧道：
   ```powershell
   cpolar http 8790
   ```
4. cpolar 会显示一个公网地址（如 `http://2d3ac7e9.r18.cpolar.top`），发给测试者即可
5. `.env` 中设置 `ALLOWED_HOSTS=*`（推荐——免费版每次重启会更换随机子域名，后缀通配或 `*` 可避免每次改配置），重启服务

**优点**：5 分钟上线。**缺点**：本机开机才可用；免费版域名随机变化、有带宽限制。

Cloudflare Tunnel 同理（`cloudflared tunnel --url http://127.0.0.1:8790`），免费但国内访问速度不稳定。

### 排错备忘

- **403 Forbidden**：Host 头不在白名单。隧道域名的 Host 头是**纯域名**（不带 `http://`、不带端口），写 `域名` 或 `.后缀` 或 `*`
- **ENOTFOUND '127.0.0.1'**：`.env` 值带了引号——解析器已兼容剥引号，更新代码后重启即可
- 隧道域名变化后无需改配置（`*` 或后缀写法已覆盖）

---

## 方式 B：轻量云服务器（正式，反馈期推荐）

1. **购机**：腾讯云/阿里云轻量应用服务器 2核2G 即可（约 ¥50-90/月）。
   - 香港/海外节点：**免备案**，国内延迟略高
   - 国内节点：绑定域名需 ICP 备案；仅用 `IP:端口` 访问可不备案但无法上 HTTPS
2. **装环境**（Ubuntu）：
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   sudo npm i -g pm2
   ```
3. **上传代码**：整个 `project_new/` 打包上传（或走 git 仓库）。**`.env` 不进 git**——在服务器上手动创建，含第 0 步的全部配置
4. **启动并守护进程**：
   ```bash
   cd project_new
   BIND=0.0.0.0 ALLOWED_HOSTS=服务器IP:8790 pm2 start server.mjs --name ami
   pm2 save && pm2 startup    # 开机自启
   ```
5. **防火墙**：云控制台安全组放行 TCP 8790
6. **访问**：`http://服务器IP:8790`

### HTTPS（强烈建议）

浏览器的**语音识别**（Web Speech API）只在 HTTPS 或 localhost 下可用——公网 HTTP 访问时 🎤 按钮会失效（文字转语音不受影响）。最省事的方案是 Caddy（自动申请续期证书）：

```bash
sudo apt install caddy
sudo nano /etc/caddy/Caddyfile
```

```
你的域名 {
    reverse_proxy 127.0.0.1:8790
}
```

然后 `.env` 中 `ALLOWED_HOSTS` 加上你的域名（此时走 Caddy 反代，Host 头为域名，不带端口），`pm2 restart ami`。

---

## 运行期注意事项

| 事项 | 说明 |
|---|---|
| 会话清理 | 演练中断的会话 2 小时无活动自动释放（内存） |
| 导出档案 | 服务器内存保留最近 30 份，重启即清空；`output/*.json` 落盘存档不受影响 |
| 并发 | 单进程串行调 LLM，2-3 人同时使用无压力；更多并发会排队变慢 |
| 反馈素材 | 每次演练自动落盘 `project_new/output/*.json`（对话/评分/设定/讲解），定期打包拉回本地即可分析 |
| Token 消耗 | 每轮演练约 20 次 LLM 调用；全流程含讲解生成约 2000-3000 token/轮 |
| 量规 | `data/rubric.json` 会保存前端编辑后的量规——部署后如需重置，删除该文件重启即恢复默认 |

---

## 上线验证清单

- [ ] 手机流量（非同一 WiFi）打开链接能访问
- [ ] 顶栏**无**"干跑模式"黄色徽章（有 = DRY_RUN 没关）
- [ ] 跑一轮模式 1 自动演练，对话与评分正常
- [ ] 模式 3 提交一句译文，评分卡出现
- [ ] 下载 docx 成功且章节齐全
- [ ] HTTPS 部署时：🎤 语音按钮可用
- [ ] OpenRouter 后台确认 key 消费上限已生效
