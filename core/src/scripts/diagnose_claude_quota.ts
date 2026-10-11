import { readFileSync } from "fs";
import { join } from "path";
import { getImpersonationHeaders, getGeminiCliHeaders } from "../utils/headers";
import { transformToGoogleBody } from "../utils/transform";
import { loadProxyConfig } from "../config/manager";
import { refreshAccessToken } from "../auth/oauth";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
await loadProxyConfig();

// 1. 读取账号
const accountsPath = process.env.ACCOUNTS_FILE || join(__dirname, "../../../data/antigravity-accounts.json");
let raw: any;
try {
  raw = JSON.parse(readFileSync(accountsPath, "utf-8"));
} catch (e: any) {
  console.error("无法读取账号文件:", accountsPath, e.message);
  process.exit(1);
}

const accounts = Array.isArray(raw) ? raw : (raw.accounts || []);
const account = accounts[0];
if (!account) {
  console.error("未找到可用账号!");
  process.exit(1);
}

console.log(`\n========================================`);
console.log(`[诊断测试] 账号: ${account.email}`);
console.log(`[诊断测试] 当前 ProjectId: ${account.projectId}`);
console.log(`[诊断测试] AccessToken 有效期至: ${new Date(account.expiresAt).toLocaleString()}`);
console.log(`========================================\n`);

// 2. 检查并刷新 Token
if (!account.accessToken || Date.now() > (account.expiresAt - 60000)) {
  console.log("AccessToken 即将过期，正在刷新...");
  try {
    const tokens = await refreshAccessToken(account.refreshToken);
    account.accessToken = tokens.access_token;
    account.expiresAt = Date.now() + (tokens.expires_in * 1000);
    console.log("Token 刷新成功!");
  } catch (e: any) {
    console.error("Token 刷新失败:", e.message);
  }
}

// 3. 检测本地代理
const candidatePorts = [7897, 7890, 7892, 7891, 1080];
let activeProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

if (!activeProxy) {
  for (const port of candidatePorts) {
    try {
      const sock = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open(s) { s.end(); },
          error() {},
        }
      });
      activeProxy = `http://127.0.0.1:${port}`;
      console.log(`[网络代理] 自动检测到本地可用代理: ${activeProxy}`);
      break;
    } catch {}
  }
}

// 4. 测试 Gemini-3.7-flash-high, Gemini-3.1-pro-high, GPT-OSS
const testTargets = [
  {
    name: "Sandbox Daily",
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    model: "gemini-3.7-flash-high"
  },
  {
    name: "Sandbox Daily",
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    model: "gemini-3.1-pro-high"
  },
  {
    name: "Sandbox Daily",
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    model: "gpt-oss-120b-medium"
  },
  {
    name: "Sandbox Daily",
    url: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    model: "claude-opus-4-6-thinking"
  }
];

for (const t of testTargets) {
  console.log(`\n==================================================`);
  console.log(`[测试] 目标端点: ${t.name}`);
  console.log(`[测试] 请求模型: ${t.model}`);

  const openaiBody = {
    model: t.model,
    messages: [{ role: "user", content: "Say HELLO" }],
    max_tokens: 16
  };

  const googleBody = transformToGoogleBody(openaiBody, account.projectId || "", false, "");
  const headers = getImpersonationHeaders(account.accessToken, account.fingerprint, googleBody.model);

  try {
    const fetchOptions: any = {
      method: "POST",
      headers,
      body: JSON.stringify(googleBody),
      verbose: true,
    };
    if (activeProxy) {
      fetchOptions.proxy = activeProxy;
    }

    const start = Date.now();
    const res = await fetch(t.url, fetchOptions);
    const duration = Date.now() - start;

    console.log(`\n>>> HTTP 响应状态: ${res.status} ${res.statusText} (耗时: ${duration}ms)`);
    if (res.ok) {
      console.log(`>>> SUCCESS! [${t.model}] 可用！`);
      const reader = res.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        console.log(`首块数据: ${new TextDecoder().decode(value).substring(0, 200)}...`);
        reader.cancel();
      }
    } else {
      const text = await res.text();
      console.log(`>>> FAILED [${t.model}]:`);
      console.log(text.substring(0, 300));
    }
  } catch (e: any) {
    console.error(`>>> 异常报错: ${e.message}`);
  }
}
