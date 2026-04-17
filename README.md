# 茹意宝 (ruyibao) Demo · GLM 版

This version uses **智谱 GLM (Zhipu AI)** instead of OpenAI, so it works reliably for Chinese users.

## 改了什么

- LLM provider 换成 **GLM (智谱 AI)**，国内用户可直接用，不需要翻墙
- 保留原有的 rule-based 降级逻辑：没配 key 或 key 失效，仍然能跑（fallback 模式）
- 环境变量改名：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL`（老的 `OPENAI_API_KEY` 仍兼容）

---

## 一、本地运行

### 1. 安装依赖

```bash
npm install
```

### 2. 申请 GLM API Key

1. 去 [https://open.bigmodel.cn/](https://open.bigmodel.cn/) 注册/登录
2. 进入 **API Keys** 页面，新建一个 key
3. 新用户通常有免费额度，够跑 demo

### 3. 配置 `.env`

```bash
cp .env.example .env
```

打开 `.env`，填入你的 key：

```env
LLM_API_KEY=your_glm_api_key_here
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=glm-4-flash
PORT=3000
```

### 4. 启动

```bash
npm start
```

打开浏览器访问 `http://localhost:3000`。

启动时终端会打印：
- `LLM mode: healthy (...)` → 真实 LLM 可用
- `LLM mode: fallback (...)` → 只用规则引擎（key 没配好）

---

## 二、部署到 Render（免费）

[Render](https://render.com) 是一个对开发者友好的托管平台，免费套餐够跑 demo。

### 步骤 1：推到 GitHub

```bash
# 在这个文件夹里执行
git init
git add .
git commit -m "ruyibao with GLM"
git branch -M main

# 到 github.com 新建一个仓库（例如叫 ruyibao），拿到地址后：
git remote add origin https://github.com/你的用户名/ruyibao.git
git push -u origin main
```

⚠️ 确认 `.env` **没有**被提交（`.gitignore` 已经排除了它）。
可以用 `git status` 检查，或上 GitHub 仓库页面看一眼文件列表。

### 步骤 2：在 Render 部署

1. 打开 [render.com](https://render.com)，用 GitHub 账号登录
2. 点 **New +** → **Web Service**
3. 连接你刚刚推的 GitHub 仓库
4. 配置：
   - **Name**：`ruyibao`（这会决定默认域名 `ruyibao.onrender.com`）
   - **Region**：选一个就行
   - **Branch**：`main`
   - **Runtime**：Node
   - **Build Command**：`npm install`
   - **Start Command**：`npm start`
   - **Instance Type**：Free
5. 在 **Environment** 区域添加环境变量：

   | Key | Value |
   |---|---|
   | `LLM_API_KEY` | 你的 GLM key |
   | `LLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` |
   | `LLM_MODEL` | `glm-4-flash` |
   | `MONGODB_URI` | 你的 MongoDB Atlas 连接字符串 |

   `PORT` 不用设置，Render 会自动注入。

6. 点 **Create Web Service**，Render 会自动构建并部署
7. 部署成功后会拿到一个公网地址，例如 `https://ruyibao.onrender.com`
8. 把地址发给你的用户即可

> 💡 Render 免费套餐的服务在闲置 15 分钟后会 sleep，第一次访问需要 30 秒左右冷启动。

### 步骤 3：以后更新

改完代码后：

```bash
git add .
git commit -m "update"
git push
```

Render 会自动重新部署。

---

## 三、排错

### 启动时显示 `LLM mode: fallback`

- 检查 `.env` 里 `LLM_API_KEY` 是否填了
- 检查 key 是否有效（去智谱平台看看额度）
- 访问 `http://localhost:3000/api/llm-health` 看具体报错

### 部署后 LLM 不工作

- 确认 Render 的 Environment 里几个变量都填了
- 注意 `LLM_BASE_URL` **不要**带末尾的斜杠
- 在 Render 日志面板看启动信息

### 想换模型

改 `LLM_MODEL`：
- `glm-4-flash`：便宜快，默认推荐
- `glm-4-air`：平衡
- `glm-4-plus`：最好但贵
- `glm-4.5` / `glm-4.6`：最新旗舰（如果你的账号可以用）

---

## 四、之后迁移到阿里云

阿里云轻量审批下来之后：

1. 买一台最便宜的轻量（¥50/月 左右，选 Ubuntu）
2. 装 Node.js 18+：`curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install nodejs`
3. 把代码克隆下来：`git clone <你的仓库>`
4. `npm install`
5. 用 `pm2` 守护进程：`npm i -g pm2 && pm2 start server.js`
6. 配置 nginx 反向代理 + 备案域名

这一步等你需要的时候再做，Render 可以先顶着用。
