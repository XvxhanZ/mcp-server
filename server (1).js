import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Octokit } from "@octokit/rest";
import { z } from "zod";

// ─── ENV ────────────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER   = process.env.REPO_OWNER;
const REPO_NAME    = process.env.REPO_NAME;
const NOTES_ROOT   = process.env.NOTES_ROOT?.replace(/\/$/, "") || "";
const DEFAULT_BRANCH = process.env.DEFAULT_BRANCH || "main";
const PORT         = process.env.PORT || 3000;

// 可选：设置后所有请求必须携带 Authorization: Bearer <MCP_API_KEY>
const MCP_API_KEY  = process.env.MCP_API_KEY || "";

// 简单限流：每个 IP 每分钟最多 60 次请求
const RATE_LIMIT   = parseInt(process.env.RATE_LIMIT || "60", 10);

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME) {
  console.error("[fatal] 缺少必要环境变量：GITHUB_TOKEN / REPO_OWNER / REPO_NAME");
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ─── 限流 ────────────────────────────────────────────────────────────────────
const rateLimitMap = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// 每 5 分钟清理过期条目
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function resolvePath(userPath, root = NOTES_ROOT) {
  const clean = userPath?.replace(/^\//, "").replace(/\/$/, "") || "";
  if (!root) return clean;
  if (!clean) return root;
  return `${root}/${clean}`;
}

// 把服务端完整路径还原为用户可见的相对路径
function relativePath(fullPath) {
  if (!NOTES_ROOT) return fullPath;
  return fullPath.startsWith(NOTES_ROOT + "/")
    ? fullPath.slice(NOTES_ROOT.length + 1)
    : fullPath;
}

async function getFileInfo(path, branch = DEFAULT_BRANCH) {
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER, repo: REPO_NAME, path, ref: branch,
    });
    return data;
  } catch {
    return null;
  }
}

function b64Encode(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

function b64Decode(str) {
  // GitHub API 返回的 base64 含换行符，需要清理
  return Buffer.from(str.replace(/\n/g, ""), "base64").toString("utf-8");
}

function ok(text)  { return { content: [{ type: "text", text }] }; }
function err(text) { return { content: [{ type: "text", text }], isError: true }; }

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ─── MCP SERVER FACTORY ──────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({ name: "obsidian-notes-mcp", version: "2.0.0" });
  const repoBase = { owner: REPO_OWNER, repo: REPO_NAME };

  // ── 1. list_notes ──────────────────────────────────────────────────────────
  server.tool(
    "list_notes",
    "列出目录下的文件和子目录",
    {
      path:   z.string().optional().describe("目录路径，留空则列出 NOTES_ROOT"),
      branch: z.string().optional().describe("分支名，默认 main"),
    },
    async ({ path, branch = DEFAULT_BRANCH }) => {
      const fullPath = resolvePath(path || "");
      try {
        const { data } = await octokit.repos.getContent({
          ...repoBase, path: fullPath, ref: branch,
        });
        const items = Array.isArray(data) ? data : [data];
        const dirs  = items.filter(i => i.type === "dir");
        const files = items.filter(i => i.type === "file" && i.name.endsWith(".md"));
        const other = items.filter(i => i.type === "file" && !i.name.endsWith(".md"));

        const lines = [
          ...dirs.map(i  => `📁 ${relativePath(i.path)}/`),
          ...files.map(i => `📄 ${relativePath(i.path)} (${formatSize(i.size)})`),
          ...(other.length ? [`── 其他文件 (${other.length} 个) ──`] : []),
        ];
        return ok(lines.join("\n") || "（空目录）");
      } catch (e) {
        return err(`list_notes 失败 "${fullPath}": ${e.message}`);
      }
    }
  );

  // ── 2. get_vault_tree ──────────────────────────────────────────────────────
  server.tool(
    "get_vault_tree",
    "递归获取整个笔记仓库的目录树（所有 .md 文件路径）",
    {
      branch: z.string().optional().describe("分支名，默认 main"),
    },
    async ({ branch = DEFAULT_BRANCH }) => {
      try {
        const { data } = await octokit.git.getTree({
          ...repoBase,
          tree_sha: branch,
          recursive: "1",
        });

        const mdFiles = data.tree
          .filter(item => item.type === "blob" && item.path.endsWith(".md"))
          .filter(item => !NOTES_ROOT || item.path.startsWith(NOTES_ROOT + "/") || item.path.startsWith(NOTES_ROOT))
          .map(item => `📄 ${relativePath(item.path)} (${formatSize(item.size || 0)})`);

        const truncated = data.truncated ? "\n\n⚠️ 文件数量超限，结果已被截断" : "";
        return ok(`共 ${mdFiles.length} 个笔记文件：\n\n${mdFiles.join("\n")}${truncated}`);
      } catch (e) {
        return err(`get_vault_tree 失败: ${e.message}`);
      }
    }
  );

  // ── 3. read_note ───────────────────────────────────────────────────────────
  server.tool(
    "read_note",
    "读取某个笔记文件的完整内容",
    {
      path:   z.string().describe("文件路径，例如 'daily/2024-01-01.md'"),
      branch: z.string().optional().describe("分支名，默认 main"),
    },
    async ({ path, branch = DEFAULT_BRANCH }) => {
      const fullPath = resolvePath(path);
      try {
        const data = await getFileInfo(fullPath, branch);
        if (!data) return err(`文件不存在：${path}`);
        if (data.type !== "file") return err(`"${path}" 不是文件`);

        const content = b64Decode(data.content);
        const lines   = content.split("\n").length;
        return ok(`文件：${relativePath(data.path)}\n大小：${formatSize(data.size)} | ${lines} 行\n分支：${branch}\n${"─".repeat(40)}\n\n${content}`);
      } catch (e) {
        return err(`read_note 失败 "${path}": ${e.message}`);
      }
    }
  );

  // ── 4. batch_read_notes ────────────────────────────────────────────────────
  server.tool(
    "batch_read_notes",
    "一次性读取多个笔记文件的内容",
    {
      paths:  z.array(z.string()).min(1).max(10).describe("文件路径列表（最多 10 个）"),
      branch: z.string().optional().describe("分支名，默认 main"),
    },
    async ({ paths, branch = DEFAULT_BRANCH }) => {
      const results = await Promise.all(
        paths.map(async (p) => {
          const fullPath = resolvePath(p);
          try {
            const data = await getFileInfo(fullPath, branch);
            if (!data || data.type !== "file") return `## ${p}\n\n（文件不存在或不是文件）`;
            const content = b64Decode(data.content);
            return `## ${relativePath(data.path)}\n\n${content}`;
          } catch (e) {
            return `## ${p}\n\n（读取失败：${e.message}）`;
          }
        })
      );
      return ok(results.join("\n\n" + "═".repeat(50) + "\n\n"));
    }
  );

  // ── 5. write_note ──────────────────────────────────────────────────────────
  server.tool(
    "write_note",
    "创建或完整覆盖一个笔记文件",
    {
      path:    z.string().describe("文件路径，例如 'ideas/new-idea.md'"),
      content: z.string().describe("笔记的完整 Markdown 内容"),
      message: z.string().optional().describe("Git commit 信息，留空则自动生成"),
      branch:  z.string().optional().describe("分支名，默认 main"),
    },
    async ({ path, content, message, branch = DEFAULT_BRANCH }) => {
      const fullPath = resolvePath(path);
      try {
        const existing = await getFileInfo(fullPath, branch);
        const isUpdate = !!existing;
        const commitMsg = message || `${isUpdate ? "update" : "create"}: ${path}`;

        await octokit.repos.createOrUpdateFileContents({
          ...repoBase,
          path: fullPath,
          message: commitMsg,
          content: b64Encode(content),
          branch,
          ...(isUpdate ? { sha: existing.sha } : {}),
        });

        return ok(`✅ ${isUpdate ? "更新" : "创建"}成功：${path}\ncommit: ${commitMsg}`);
      } catch (e) {
        return err(`write_note 失败 "${path}": ${e.message}`);
      }
    }
  );

  // ── 6. append_to_note ─────────────────────────────────────────────────────
  server.tool(
    "append_to_note",
    "在现有笔记末尾追加内容，不覆盖原文",
    {
      path:    z.string().describe("文件路径"),
      content: z.string().describe("要追加的 Markdown 内容"),
      separator: z.string().optional().describe("追加前插入的分隔内容（默认空两行）"),
      message: z.string().optional().describe("Git commit 信息"),
      branch:  z.string().optional().describe("分支名，默认 main"),
    },
    async ({ path, content, separator, message, branch = DEFAULT_BRANCH }) => {
      const fullPath = resolvePath(path);
      try {
        const data = await getFileInfo(fullPath, branch);
        if (!data) return err(`文件不存在：${path}`);

        const existing = b64Decode(data.content);
        const sep      = separator !== undefined ? separator : "\n\n";
        const updated  = existing.trimEnd() + sep + content;

        await octokit.repos.createOrUpdateFileContents({
          ...repoBase,
          path: fullPath,
          message: message || `append: ${path}`,
          content: b64Encode(updated),
          sha: data.sha,
          branch,
        });

        return ok(`✅ 已追加到：${path}`);
      } catch (e) {
        return err(`append_to_note 失败 "${path}": ${e.message}`);
      }
    }
  );

  // ── 7. move_note ──────────────────────────────────────────────────────────
  server.tool(
    "move_note",
    "移动或重命名一个笔记文件（先创建新文件，再删除旧文件，两步 commit）",
    {
      from_path: z.string().describe("原始路径"),
      to_path:   z.string().describe("目标路径"),
      message:   z.string().optional().describe("Git commit 信息"),
      branch:    z.string().optional().describe("分支名，默认 main"),
    },
    async ({ from_path, to_path, message, branch = DEFAULT_BRANCH }) => {
      const fromFull = resolvePath(from_path);
      const toFull   = resolvePath(to_path);
      try {
        // 读原文件
        const srcData = await getFileInfo(fromFull, branch);
        if (!srcData) return err(`原文件不存在：${from_path}`);

        const content = b64Decode(srcData.content);

        // 检查目标是否已存在
        const dstData = await getFileInfo(toFull, branch);

        // 创建目标文件
        await octokit.repos.createOrUpdateFileContents({
          ...repoBase,
          path: toFull,
          message: message || `move: ${from_path} → ${to_path}`,
          content: b64Encode(content),
          branch,
          ...(dstData ? { sha: dstData.sha } : {}),
        });

        // 删除原文件
        await octokit.repos.deleteFile({
          ...repoBase,
          path: fromFull,
          message: message || `move (cleanup): ${from_path}`,
          sha: srcData.sha,
          branch,
        });

        return ok(`✅ 已移动：${from_path} → ${to_path}`);
      } catch (e) {
        return err(`move_note 失败: ${e.message}`);
      }
    }
  );

  // ── 8. delete_note ────────────────────────────────────────────────────────
  server.tool(
    "delete_note",
    "删除某个笔记文件",
    {
      path:    z.string().describe("要删除的文件路径"),
      message: z.string().optional().describe("Git commit 信息"),
      branch:  z.string().optional().describe("分支名，默认 main"),
    },
    async ({ path, message, branch = DEFAULT_BRANCH }) => {
      const fullPath = resolvePath(path);
      try {
        const data = await getFileInfo(fullPath, branch);
        if (!data) return err(`文件不存在：${path}`);

        await octokit.repos.deleteFile({
          ...repoBase,
          path: fullPath,
          message: message || `delete: ${path}`,
          sha: data.sha,
          branch,
        });

        return ok(`🗑️ 已删除：${path}`);
      } catch (e) {
        return err(`delete_note 失败 "${path}": ${e.message}`);
      }
    }
  );

  // ── 9. search_notes ───────────────────────────────────────────────────────
  server.tool(
    "search_notes",
    "在仓库中搜索包含关键词的笔记文件（依赖 GitHub Code Search，新文件可能有几分钟延迟）",
    {
      query:       z.string().describe("搜索关键词"),
      max_results: z.number().int().min(1).max(30).optional().describe("最多返回条数（默认 10）"),
    },
    async ({ query, max_results = 10 }) => {
      try {
        const q = `${query} repo:${REPO_OWNER}/${REPO_NAME} extension:md`;
        const { data } = await octokit.search.code({ q, per_page: max_results });

        if (!data.items.length) {
          return ok(`没有找到包含 "${query}" 的笔记`);
        }

        const lines = data.items.map((item, i) =>
          `${i + 1}. ${relativePath(item.path)}`
        );

        return ok(
          `搜索 "${query}"，共 ${data.total_count} 条，显示前 ${data.items.length} 条：\n\n${lines.join("\n")}`
        );
      } catch (e) {
        return err(`search_notes 失败: ${e.message}`);
      }
    }
  );

  // ── 10. get_recent_notes ──────────────────────────────────────────────────
  server.tool(
    "get_recent_notes",
    "获取最近修改的笔记文件列表（基于 Git commit 记录）",
    {
      limit:  z.number().int().min(1).max(50).optional().describe("返回条数（默认 20）"),
      branch: z.string().optional().describe("分支名，默认 main"),
    },
    async ({ limit = 20, branch = DEFAULT_BRANCH }) => {
      try {
        const { data: commits } = await octokit.repos.listCommits({
          ...repoBase,
          sha: branch,
          per_page: limit * 3, // 多取一些，因为一个 commit 可能改多个文件
        });

        const seen  = new Set();
        const notes = [];

        for (const commit of commits) {
          if (notes.length >= limit) break;
          const { data: detail } = await octokit.repos.getCommit({
            ...repoBase,
            ref: commit.sha,
          });

          for (const file of detail.files || []) {
            if (notes.length >= limit) break;
            if (!file.filename.endsWith(".md")) continue;
            if (seen.has(file.filename)) continue;
            if (NOTES_ROOT && !file.filename.startsWith(NOTES_ROOT)) continue;

            seen.add(file.filename);
            const relPath = relativePath(file.filename);
            const date    = commit.commit.author.date.slice(0, 10);
            const msg     = commit.commit.message.split("\n")[0];
            notes.push(`${date} | ${relPath}\n         └─ ${msg}`);
          }
        }

        if (!notes.length) return ok("暂无最近修改记录");
        return ok(`最近修改的笔记（${notes.length} 条）：\n\n${notes.join("\n")}`);
      } catch (e) {
        return err(`get_recent_notes 失败: ${e.message}`);
      }
    }
  );

  // ── 11. get_note_history ──────────────────────────────────────────────────
  server.tool(
    "get_note_history",
    "查看某个笔记文件的修改历史",
    {
      path:   z.string().describe("文件路径"),
      limit:  z.number().int().min(1).max(30).optional().describe("返回条数（默认 10）"),
      branch: z.string().optional().describe("分支名，默认 main"),
    },
    async ({ path, limit = 10, branch = DEFAULT_BRANCH }) => {
      const fullPath = resolvePath(path);
      try {
        const { data: commits } = await octokit.repos.listCommits({
          ...repoBase,
          sha: branch,
          path: fullPath,
          per_page: limit,
        });

        if (!commits.length) return ok(`"${path}" 暂无历史记录`);

        const lines = commits.map((c, i) => {
          const date = c.commit.author.date.slice(0, 16).replace("T", " ");
          const author = c.commit.author.name;
          const msg    = c.commit.message.split("\n")[0];
          return `${i + 1}. [${date}] ${author}\n   ${msg}\n   ${c.sha.slice(0, 7)}`;
        });

        return ok(`"${path}" 的修改历史（${commits.length} 条）：\n\n${lines.join("\n\n")}`);
      } catch (e) {
        return err(`get_note_history 失败 "${path}": ${e.message}`);
      }
    }
  );

  return server;
}

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 鉴权中间件（仅在设置了 MCP_API_KEY 时启用）
app.use((req, res, next) => {
  if (req.path === "/") return next(); // 健康检查不鉴权
  if (!MCP_API_KEY)    return next(); // 未配置则跳过

  const auth = req.headers.authorization || "";
  if (auth === `Bearer ${MCP_API_KEY}`) return next();

  console.warn(`[auth] 拒绝未授权请求: ${req.path} from ${req.ip}`);
  return res.status(401).json({ error: "Unauthorized" });
});

// 限流中间件
app.use((req, res, next) => {
  const ip = req.ip || "unknown";
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
});

// Session 管理
const activeSessions = new Map();

// ─── SSE 入口（修复 Render 反向代理缓冲 + 心跳保活）────────────────────────
app.get("/sse", async (req, res) => {
  const ip = req.ip || "unknown";
  console.log(`[SSE] new connection from ${ip}`);

  // 禁止 Render / nginx 缓冲响应流，否则 SSE 会被憋死
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const transport = new SSEServerTransport("/messages", res);
  const server    = createMcpServer();

  // 每 30 秒发一个注释心跳，防止 Render 90s idle timeout 踢掉连接
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 30_000);

  activeSessions.set(transport.sessionId, { transport, server });

  res.on("close", () => {
    clearInterval(heartbeat);
    console.log(`[SSE] session closed: ${transport.sessionId}`);
    activeSessions.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// 消息接收
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session   = activeSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found or expired" });
  }

  await session.transport.handlePostMessage(req, res);
});

// 健康检查
app.get("/", (req, res) => {
  res.json({
    name:        "obsidian-notes-mcp",
    version:     "2.0.0",
    status:      "ok",
    repo:        `${REPO_OWNER}/${REPO_NAME}`,
    notes_root:  NOTES_ROOT || "(repo root)",
    branch:      DEFAULT_BRANCH,
    sessions:    activeSessions.size,
    auth:        MCP_API_KEY ? "enabled" : "disabled",
    tools: [
      "list_notes", "get_vault_tree",
      "read_note", "batch_read_notes",
      "write_note", "append_to_note",
      "move_note", "delete_note",
      "search_notes", "get_recent_notes", "get_note_history",
    ],
  });
});

// 404 兜底
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// 优雅关闭
const httpServer = app.listen(PORT, () => {
  console.log(`[start] obsidian-notes-mcp v2.0.0 on port ${PORT}`);
  console.log(`[start] repo: ${REPO_OWNER}/${REPO_NAME}, root: "${NOTES_ROOT || "/"}", branch: ${DEFAULT_BRANCH}`);
  console.log(`[start] auth: ${MCP_API_KEY ? "enabled" : "disabled"}`);
});

function shutdown(signal) {
  console.log(`[${signal}] shutting down...`);
  httpServer.close(() => {
    console.log("[shutdown] done");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
