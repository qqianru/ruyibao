// parent_llm.js - 家长教练 LLM 调用
//
// 这个模块给 /parents 路由用。和 llm.js 共享 GLM 客户端，但有自己的:
//   - 系统提示词 (从 server/prompts 读取并拼接)
//   - 调用函数 generateParentCoachReply
//   - 触发检测 detectExpertFollowupTrigger
//   - 对话摘要 generateConversationSummary (给后台员工看)

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

// ============================================================
// 系统提示词加载 (启动时读一次,缓存在内存)
// ============================================================

const PROMPT_DIR = path.join(__dirname, 'server', 'prompts');

let cachedSystemPrompt = null;

function loadSystemPrompt() {
  if (cachedSystemPrompt) return cachedSystemPrompt;
  try {
    const instructions = fs.readFileSync(path.join(PROMPT_DIR, '03_system_prompt.md'), 'utf8');
    const framework = fs.readFileSync(path.join(PROMPT_DIR, '01_framework.md'), 'utf8');
    const cases = fs.readFileSync(path.join(PROMPT_DIR, '02_case_index.md'), 'utf8');
    // 顺序: 指令 → 框架 → 案例库
    cachedSystemPrompt =
      instructions + '\n\n---\n\n# 框架核心 (framework.md)\n\n' + framework +
      '\n\n---\n\n# 案例库索引 (case_index.md)\n\n' + cases;
    const sizeKB = Math.round(cachedSystemPrompt.length / 1024);
    const charCount = cachedSystemPrompt.length;
    console.log(`[ParentLLM] System prompt loaded: ${charCount} chars ≈ ${sizeKB}KB ≈ ${Math.round(charCount * 1.5 / 1000)}K tokens`);
    return cachedSystemPrompt;
  } catch (err) {
    console.error('[ParentLLM] Failed to load system prompt files:', err.message);
    console.error('[ParentLLM] Make sure server/prompts/01_framework.md, 02_case_index.md, 03_system_prompt.md exist');
    return null;
  }
}

// ============================================================
// LLM 客户端 (从环境变量读)
// ============================================================

function getApiKey() {
  return (process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
}

function getBaseUrl() {
  return (process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').trim();
}

// 家长教练默认用 glm-4.6 (支持 prompt cache, 节省 60-70% 成本)
// 可以通过 LLM_PARENT_MODEL 环境变量覆盖
function getParentModel() {
  return (process.env.LLM_PARENT_MODEL || 'glm-4.6').trim();
}

let client = null;
function getClient() {
  if (client) return client;
  const key = getApiKey();
  if (!key) return null;
  client = new OpenAI({ apiKey: key, baseURL: getBaseUrl() });
  return client;
}

// ============================================================
// 主调用: generateParentCoachReply
// ============================================================

/**
 * Generate a parent coach reply.
 * @param {Array} messages - [{role: 'user'|'assistant', content: '...'}, ...]
 * @returns {Promise<{content: string, error?: string, usage?: object}>}
 */
async function generateParentCoachReply(messages) {
  const c = getClient();
  if (!c) {
    return { error: '没有配置 LLM_API_KEY，家长教练暂时不可用。' };
  }
  const systemPrompt = loadSystemPrompt();
  if (!systemPrompt) {
    return { error: '系统提示词加载失败。请检查 server/prompts 目录。' };
  }

  // GLM 自动缓存相同前缀。把系统提示词永远放在第一位,保证缓存命中。
  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  try {
    // 自动重试 429 (rate limit) 和 5xx 错误
    // 等待时间: 1s, 3s, 7s (指数回退,最多 3 次重试)
    const RETRY_DELAYS_MS = [1000, 3000, 7000];
    let lastError = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const resp = await c.chat.completions.create({
          model: getParentModel(),
          messages: apiMessages,
          temperature: 0.7,
          max_tokens: 600
        });

        const content = resp.choices?.[0]?.message?.content || '';
        const usage = resp.usage || {};

        // 缓存监控日志
        const promptTokens = usage.prompt_tokens || 0;
        const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
        const completionTokens = usage.completion_tokens || 0;
        const cacheHitRate = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
        if (cachedTokens > 0) {
          console.log(`[ParentLLM] ✓ cache hit: ${cachedTokens}/${promptTokens} prompt tokens (${cacheHitRate}%) + ${completionTokens} output${attempt > 0 ? ` (after ${attempt} retries)` : ''}`);
        } else {
          console.log(`[ParentLLM] ✗ cache miss: ${promptTokens} prompt tokens (full price) + ${completionTokens} output${attempt > 0 ? ` (after ${attempt} retries)` : ''}`);
        }
        return { content, usage };
      } catch (err) {
        lastError = err;
        const status = err?.status || err?.response?.status || 0;
        const isRetryable = status === 429 || (status >= 500 && status < 600);

        if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) {
          console.error(`[ParentLLM] generateParentCoachReply failed (attempt ${attempt + 1}, status ${status}):`, err?.message || err);
          break;
        }

        const wait = RETRY_DELAYS_MS[attempt];
        console.warn(`[ParentLLM] ${status} on attempt ${attempt + 1}, retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      }
    }

    // 所有重试都失败了, 返回友好的错误提示
    const status = lastError?.status || lastError?.response?.status || 0;
    if (status === 429) {
      return { error: '当前请求人数较多，请等几秒再试一次。' };
    }
    return { error: '抱歉，教练暂时回复不了。请稍后再试。' };
  } catch (err) {
    console.error('[ParentLLM] generateParentCoachReply unexpected error:', err?.message || err);
    return { error: '抱歉，教练暂时回复不了。请稍后再试。' };
  }
}

// ============================================================
// 触发检测: detectExpertFollowupTrigger
// ============================================================

// ============================================================
// 流式调用: generateParentCoachReplyStream (NEW - 体验更快)
// ============================================================

/**
 * 流式生成家长教练回复. 通过 onToken 回调逐 token 推送给上游 (server.js
 * 再用 SSE 推给浏览器).
 *
 * @param {Array} messages - [{role: 'user'|'assistant', content: '...'}, ...]
 * @param {Function} onToken - 每接到一个 token 时调用 (text: string) => void
 * @param {Function} [onError] - 出错时调用 (error: string) => void
 * @returns {Promise<{fullContent: string, usage: object, error?: string}>}
 *           resolved 后 fullContent 是拼好的完整回复, 用于存数据库 + 触发检测
 */
async function generateParentCoachReplyStream(messages, onToken, onError) {
  const c = getClient();
  if (!c) {
    const err = '没有配置 LLM_API_KEY，家长教练暂时不可用。';
    if (onError) onError(err);
    return { error: err, fullContent: '' };
  }
  const systemPrompt = loadSystemPrompt();
  if (!systemPrompt) {
    const err = '系统提示词加载失败。请检查 server/prompts 目录。';
    if (onError) onError(err);
    return { error: err, fullContent: '' };
  }

  const apiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  // 重试逻辑跟非流式版一样
  const RETRY_DELAYS_MS = [1000, 3000, 7000];
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const stream = await c.chat.completions.create({
        model: getParentModel(),
        messages: apiMessages,
        temperature: 0.7,
        max_tokens: 600,
        stream: true,
        thinking: { type: "disabled" }
        // 注意: 去掉了 stream_options.include_usage — GLM 某些 model 不支持会报错
      });

      let fullContent = '';
      let usage = {};

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          if (onToken) onToken(delta);
        }
        if (chunk.usage) {
          usage = chunk.usage;
        }
      }

      // 流式结束后,记录 cache 监控
      const promptTokens = usage.prompt_tokens || 0;
      const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
      const completionTokens = usage.completion_tokens || 0;
      const cacheHitRate = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
      if (cachedTokens > 0) {
        console.log(`[ParentLLM-stream] ✓ cache hit: ${cachedTokens}/${promptTokens} prompt tokens (${cacheHitRate}%) + ${completionTokens} output${attempt > 0 ? ` (after ${attempt} retries)` : ''}`);
      } else {
        console.log(`[ParentLLM-stream] ✗ cache miss: ${promptTokens} prompt tokens (full price) + ${completionTokens} output${attempt > 0 ? ` (after ${attempt} retries)` : ''}`);
      }
      return { fullContent, usage };
    } catch (err) {
      lastError = err;
      const status = err?.status || err?.response?.status || 0;
      const isRetryable = status === 429 || (status >= 500 && status < 600);

      if (!isRetryable || attempt >= RETRY_DELAYS_MS.length) {
        console.error(`[ParentLLM-stream] failed (attempt ${attempt + 1}, status ${status}):`, err?.message || err);
        break;
      }

      const wait = RETRY_DELAYS_MS[attempt];
      console.warn(`[ParentLLM-stream] ${status} on attempt ${attempt + 1}, retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  const status = lastError?.status || lastError?.response?.status || 0;
  const errMsg = status === 429
    ? '当前请求人数较多，请等几秒再试一次。'
    : '抱歉，教练暂时回复不了。请稍后再试。';
  if (onError) onError(errMsg);
  return { error: errMsg, fullContent: '' };
}

// ============================================================
// 触发检测: detectExpertFollowupTrigger
// ============================================================

// 严重信号触发词 (必须包含"主动"或"超出范围"才算 severe)
const SEVERE_PATTERNS = [
  /我们后台工作人员会安排心理学专家主动联系/,
  /专家.*主动联系你/,
  /这超出今晚我们能在这里聊清楚的范围/,
  /今晚.*需要专业人在场/,
  /必须.*寻求专业.*帮助/
];

// 非紧急的真人转介触发词
const NON_CRISIS_PATTERNS = [
  /可以让我们后台工作人员安排心理学专家联系/,
  /做一次比较深入的咨询/,
  /我把(这个|你的)需求记下来/,
  /把.*情况记下来/
];

/**
 * Detect whether the LLM's reply triggers expert follow-up.
 * @param {string} replyContent - The LLM's reply text
 * @returns {{triggered: boolean, urgency: 'severe'|'non_crisis'|null}}
 */
function detectExpertFollowupTrigger(replyContent) {
  if (!replyContent) return { triggered: false, urgency: null };

  // 优先检测严重信号 (覆盖范围更大,优先级更高)
  for (const pat of SEVERE_PATTERNS) {
    if (pat.test(replyContent)) {
      return { triggered: true, urgency: 'severe' };
    }
  }
  for (const pat of NON_CRISIS_PATTERNS) {
    if (pat.test(replyContent)) {
      return { triggered: true, urgency: 'non_crisis' };
    }
  }
  return { triggered: false, urgency: null };
}

// ============================================================
// 关键词兜底: 检测家长消息里的严重信号关键词
// 不依赖 LLM 是否合作 — 只要家长发了这些词,就强制触发严重转介
// ============================================================

const CRISIS_USER_KEYWORDS = [
  // 自伤
  /自伤/, /自残/, /划痕/, /划手腕/, /割腕/, /伤害自己/, /伤自己/,
  /拿刀/, /刀片/, /用刀划/, /撞墙/, /扎自己/, /用笔扎/,
  // 自杀念头
  /想自杀/, /不想活/, /想死/, /活着没意思/, /没意思活/, /想消失/,
  /轻生/, /结束生命/, /跳楼/, /上吊/, /服药/.source && /吃药.*死/,
  // 厌食/暴食极端
  /好几天没吃/, /吐光/, /催吐/,
  // 拒学严重
  /好几个月没去学校/, /彻底不去/,
  // 幻觉
  /听到声音.*指挥/, /有声音.*让我/,
  // 家长崩溃
  /我撑不住/, /我也想死/, /我不想活/
];

/**
 * 在家长发送的消息里检测严重信号关键词.
 * 这是 LLM-independent 的安全网 — 关键词命中,不管 LLM 怎么回都强制触发严重转介.
 *
 * @param {string} userMessage - 家长这次发的话
 * @returns {boolean} - 命中了就 true
 */
function detectCrisisInUserMessage(userMessage) {
  if (!userMessage) return false;
  const text = String(userMessage);
  return CRISIS_USER_KEYWORDS.some(pat => {
    if (pat instanceof RegExp) return pat.test(text);
    return false;
  });
}

// 兜底转介话术 (当 LLM 该说但没说时,强制追加这段到回复末尾)
const SAFETY_NET_SEVERE_APPEND = '\n\n---\n\n⚠️ **重要提醒**\n\n你提到的情况——比如孩子出现自伤行为或表达"活着没意思"——这超出今晚我们能在这里聊清楚的范围。**我们后台工作人员会安排心理学专家主动联系你**，做一次面对面的评估。\n\n请在下方留下电话，方便我们联系。这一步不能跳。';

// ============================================================
// 对话摘要 (给后台员工看)
// ============================================================

/**
 * Generate a brief summary of a parent conversation for backend staff.
 * @param {Array} messages - The full conversation
 * @returns {Promise<string>}
 */
async function generateConversationSummary(messages) {
  const c = getClient();
  if (!c) return '(无法生成摘要：LLM 未配置)';

  // 只用前 8 条消息生成摘要 (够用,且省 token)
  const sampleMessages = messages.slice(0, 8);
  const transcript = sampleMessages
    .map(m => `${m.role === 'user' ? '家长' : '教练'}: ${m.content.slice(0, 300)}`)
    .join('\n\n');

  try {
    const resp = await c.chat.completions.create({
      model: getParentModel(),
      messages: [
        {
          role: 'system',
          content: '你是一位心理咨询助手。给定一段家长和 AI 教练的对话节选，请用 2-3 句话总结：(1) 家长的孩子大约什么情况；(2) 家长当前最大的困扰；(3) 是否有需要立刻关注的紧急信号 (自伤、轻生、严重拒学等)。简洁、客观。不要给建议。'
        },
        { role: 'user', content: transcript }
      ],
      temperature: 0.3,
      max_tokens: 300
    });
    return resp.choices?.[0]?.message?.content || '(摘要为空)';
  } catch (err) {
    console.error('[ParentLLM] generateConversationSummary error:', err?.message || err);
    return '(摘要生成失败)';
  }
}

// ============================================================
// Health check (用于启动时验证)
// ============================================================

function getStatus() {
  const promptLoaded = !!cachedSystemPrompt;
  return {
    apiKeyConfigured: !!getApiKey(),
    model: getParentModel(),
    baseUrl: getBaseUrl(),
    promptLoaded,
    promptSize: promptLoaded ? cachedSystemPrompt.length : 0
  };
}

module.exports = {
  loadSystemPrompt,
  generateParentCoachReply,
  generateParentCoachReplyStream,
  detectExpertFollowupTrigger,
  detectCrisisInUserMessage,
  SAFETY_NET_SEVERE_APPEND,
  generateConversationSummary,
  getStatus
};
