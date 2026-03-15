# obsidian-notes-mcp v2

通过 GitHub API 操作 Obsidian 笔记仓库的 MCP Server，SSE transport，可部署到 Render 免费套餐。

---

## 工具列表（11 个）

| 工具 | 说明 |
|---|---|
| `list_notes` | 列出目录下的文件和子目录 |
| `get_vault_tree` | 递归获取整个 vault 的所有 `.md` 文件 |
| `read_note` | 读取某个笔记的完整内容 |
| `batch_read_notes` | 一次读取多个笔记（最多 10 个） |
| `write_note` | 创建或覆盖笔记 |
| `append_to_note` | 追加内容到笔记末尾（不覆盖） |
| `move_note` | 移动或重命名笔记 |
| `delete_note` | 删除笔记 |
| `search_notes` | 全仓库关键词搜索 |
| `get_recent_notes` | 获取最近修改的笔记列表 |
| `get_note_history` | 查看某个笔记的 Git 修改历史 |

---

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | ✅ | GitHub Fine-grained Token |
| `REPO_OWNER` | ✅ | 你的 GitHub 用户名 |
| `REPO_NAME` | ✅ | Obsidian 仓库名 |
| `NOTES_ROOT` | ❌ | 笔记所在子目录（留空则为仓库根目录）|
| `DEFAULT_BRANCH` | ❌ | 默认分支，默认 `main` |
| `MCP_API_KEY` | ❌ | 设置后所有请求需携带 `Authorization: Bearer <key>` |
| `RATE_LIMIT` | ❌ | 每 IP 每分钟最大请求数，默认 60 |
| `PORT` | ❌ | Render 会自动注入，不用手动设 |

---

## 部署到 Render

### 1. 创建 GitHub Token

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens

- Repository access：选你的 Obsidian 仓库
- Permissions：`Contents` → Read and write，`Metadata` → Read

### 2. 推代码到 GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/你的用户名/obsidian-notes-mcp.git
git push -u origin main
```

### 3. Render 配置

1. https://render.com → New → Web Service
2. 连接仓库
3. 填写：
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: `Free`
4. 填环境变量（见上表）

---

## MCP 客户端连接

```
SSE:      https://your-app.onrender.com/sse
Messages: https://your-app.onrender.com/messages?sessionId=<id>
健康检查: https://your-app.onrender.com/
```

如果设置了 `MCP_API_KEY`，请求头需要加：

```
Authorization: Bearer <你的 MCP_API_KEY>
```

---

## 注意事项

- Render 免费套餐无流量时会休眠，首次唤醒约 30 秒
- `search_notes` 依赖 GitHub Code Search，新提交的文件可能需要几分钟才能被索引
- `get_recent_notes` 会发多个 API 请求，速度稍慢属正常
- 建议在 Obsidian 中安装 **Obsidian Git** 插件并设置自动 push，确保 AI 读到的是最新内容
