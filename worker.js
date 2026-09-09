/**
 * tg-send-msg-exam-bot — Cloudflare Worker 版
 *
 * 设计 (与 VPS 版 tg-send-msg-exam-bot-1.py 的行为映射):
 *  - webhook 推模式替代 getUpdates 长轮询
 *  - 单群模式: 只处理 CHAT_ID 配置的群 (未配置/占位符时一律跳过)
 *  - 题库: 按 user_id 快速哈希固定题型 (blog/rss/youtube 三选一, 同一用户永远同一种题)
 *      blog    题面"我的博客地址是什么?"         固定答案 zelikk.blogspot.com
 *      rss     题面"我的博客的最新一期博文标题是什么?"  动态, 判分时实时抓 RSS 首个标题
 *      youtube 题面"我的Youtube频道url是什么?"   固定答案 youtube.com/@crazypeace
 *  - 状态全部在 KV (worker 无内存态):
 *      PENDING[user_id] = {join_time, stored_messages:[{message_id, original_chat_id}]}  TTL 24h
 *                        记录存在即视为"待验证" (对齐 VPS 版 pending_users 语义)
 *      VALID[user_id]   = 任意值 (空串/乱码/JSON 均可), key 存在即有效 = 已验证白名单
 *  - 未验证用户 (ID>=8B 且不在白名单) 在群里发消息:
 *      禁言 -> 转发到仓库频道 -> 删原消息 -> 记 pending -> 群内警告 (不自动删)
 *  - 判定只看 ID 阈值 + 自家 VALID 白名单, 不看 Telegram 服务端权限状态:
 *    被 join-group 验证放行 (restricted+can_send=true)、或管理员解除限制 (status=member) 的用户,
 *    只要不在白名单, 发言即再次禁言 (与 tg-join-group-exam 不同: 那边"能发言=已验证", 这边"能发言≠已验证")
 *  - 私聊 /start: 仅待验证用户出题; 已验证 -> "已通过验证"; 其余 -> 简介
 *  - 私聊答题: 归一化子串匹配 (对齐 VPS correct in user_answer);
 *      通过 -> 解除禁言 + 写 VALID + 恢复暂存消息 + 群内通知
 *  - 管理员命令 /add_valid_user <user_id> (群内): 手动放行待验证用户
 *  - 无任何自动删消息逻辑 (定时删除通知消息功能已砍)
 *
 * 环境变量 (wrangler secret / vars):
 *  - BOT_TOKEN     : secret, 机器人 token
 *  - SECRET_TOKEN  : secret, webhook 校验用; 部署后 GET /registerWebhook 自注册
 *  - CHAT_ID       : vars, 目标群 ID (-100xxxxxxxxxx)
 *  - STORAGE_CHANNEL_ID: vars, 仓库频道 ID
 *  - RSS_URL       : vars, 博客的RSS
 *  KV bindings: PENDING, VALID
 */

const TG_API = "https://api.telegram.org/bot";
const LEGACY_USER_ID_MAX = 8000000000; // ID < 8B = 早期用户, 免验证 (VPS 版阈值, 不是 2B)
const PENDING_TTL_SECONDS = 86400; // 24h

const Q_TYPES = ["rss", "youtube", "blog"];

const BLOG_ANSWER = "zelikk.blogspot.com";
const YOUTUBE_ANSWER = "youtube.com/@crazypeace";

const QUESTION_TEXT = {
  blog: "❓ 请问：我的博客地址是什么？",
  rss: "❓ 请问：我的博客的最新一期博文标题是什么？",
  youtube: "❓ 请问：我的Youtube频道url是什么？",
};

const INTRO_TEXT =
  "👋 你好！我是群组验证机器人。\n\n" +
  "🔹 当你在群组中发送消息时，我会检查你是否已验证\n" +
  "🔹 未验证用户会被暂时禁言，并需要完成人机验证\n" +
  "🔹 未验证用户需要向我发送 /start 并回答验证问题\n" +
  "🔹 验证通过后，我会自动解除禁言";

// 与 VPS 版 ChatPermissions 逐字段一致; 
const MUTE_PERMISSIONS = {
  can_send_messages: false,
  // can_send_audios: false,
  // can_send_documents: false,
  // can_send_photos: false,
  // can_send_videos: false,
  // can_send_video_notes: false,
  // can_send_voice_notes: false,
  // can_send_polls: false,
  // can_send_other_messages: false,
  // can_add_web_page_previews: false,
};

const DEFAULT_PERMISSIONS = {
  can_send_messages: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_audios: true,
  can_send_voice_notes: true,
  can_send_documents: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_send_polls: true,
};

// ---------------------------------------------------------------- 基础设施

async function api(env, method, payload) {
  const res = await fetch(`${TG_API}${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(
      `${method} failed: ${data.error_code} ${data.description}` +
        ` (chat=${payload.chat_id} user=${payload.user_id ?? ""})`
    );
  }
  return data.result;
}

// 机器人自身 username / 目标群标题, isolate 内缓存一次
let _botUsername = null;
async function botUsername(env) {
  if (!_botUsername) {
    const me = await api(env, "getMe", {});
    _botUsername = me.username;
  }
  return _botUsername;
}

let _chatTitle = null;
async function chatTitle(env) {
  if (_chatTitle == null) {
    const c = await api(env, "getChat", { chat_id: env.CHAT_ID });
    _chatTitle = c.title || String(env.CHAT_ID);
  }
  return _chatTitle;
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

// Python user.mention_markdown() 的等价物 (HTML parse_mode, 免去 MarkdownV2 转义)
function mention(user) {
  const name = escapeHtml(user.first_name || user.username || String(user.id));
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

function log(line) {
  console.log(new Date().toISOString(), line);
}

// ---------------------------------------------------------------- 工具: 群判定 / 白名单

// 单群模式: 写操作仅响应 CHAT_ID 配置的群; 未配置/占位符 = 未启用, 一律跳过
function isTargetChat(env, chatId) {
  const want = String(env.CHAT_ID ?? "").trim();
  return want !== "" && !want.includes("REPLACE") && String(chatId) === want;
}

function storageConfigured(env) {
  const v = String(env.STORAGE_CHANNEL_ID ?? "").trim();
  return v !== "" && !v.includes("REPLACE");
}

// 是否目标群成员: member/administrator/creator/restricted 都算在群内
// (restricted = 在群里但被禁言 —— 正是"待验证成员"的状态, 绝不能排除)
async function isInGroup(env, chatId, userId) {
  try {
    const m = await api(env, "getChatMember", { chat_id: chatId, user_id: userId });
    return ["member", "administrator", "creator", "restricted"].includes(m.status);
  } catch {
    return false;
  }
}

// 免验证老号 (VPS 版: ID < 8B 不需要验证)
function isLegacy(id) {
  return id < LEGACY_USER_ID_MAX;
}

// 白名单: VALID KV key 存在即有效 (value 任意)
async function isValidUser(env, id) {
  if (isLegacy(id)) return true;
  return (await env.VALID.get(String(id))) !== null;
}

// ---------------------------------------------------------------- 题库

// 非常快的 32-bit 混合 (Knuth 黄金比例乘法 + xorshift), 仅整数运算, 无字符串/BigInt
function questionType(userId) {
  let x = Math.imul(userId | 0, 0x9e3779b1) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x21f0aaad) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; // 末尾必须再转 unsigned, 否则可能为负 -> %3 得负索引
  return Q_TYPES[x % 3];
}

// 归一化: 统一小写、去掉全部空白 — 与 VPS 版 re.sub(r'\s+','',x.lower()) 一致
function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, "");
}

// 判分: 正确答案非空且为用户答案的子串 (对齐 VPS correct in user_answer)
function checkAnswer(correct, answer) {
  const c = normalize(correct);
  return c.length > 0 && normalize(answer).includes(c);
}

// 解析 RSS, 取第一个 <item> 的 <title>; 支持 CDATA。失败抛错。
function parseRssTitle(xml) {
  const itemStart = xml.search(/<item[\s>]/i);
  const scope = itemStart >= 0 ? xml.slice(itemStart) : xml;
  const m = scope.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) throw new Error("RSS: no item title found");
  let title = m[1].trim();
  const cdata = title.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) title = cdata[1].trim();
  if (!title) throw new Error("RSS: empty title");
  return title;
}

async function fetchLatestPostTitle(env) {
  const url = env.RSS_URL;
  const res = await fetch(url, {
    headers: { "User-Agent": "tg-send-msg-exam-bot/1.0" },
    cf: { cacheTtl: 60 }, // 60s 边缘缓存, 抗洪峰
  });
  if (!res.ok) throw new Error(`RSS fetch HTTP ${res.status}`);
  return parseRssTitle(await res.text());
}

// 取某题型当前正确答案: blog/youtube 固定常量; rss 实时抓 (失败抛错)
async function computeAnswer(env, type) {
  if (type === "blog") return BLOG_ANSWER;
  if (type === "youtube") return YOUTUBE_ANSWER;
  return await fetchLatestPostTitle(env);
}

// ---------------------------------------------------------------- 验证成功流程 (共用)

function userMeta(u) {
  const full = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return {
    username: u.username || "",
    full_name: full || u.username || String(u.id),
    verified_at: new Date().toISOString(),
  };
}

async function readPending(env, userId) {
  const raw = await env.PENDING.get(String(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 验证通过: 解除禁言 + 写白名单 + 恢复仓库暂存消息 + 删 pending
async function verifySuccess(env, userId, user) {
  await api(env, "restrictChatMember", {
    chat_id: env.CHAT_ID,
    user_id: userId,
    permissions: DEFAULT_PERMISSIONS,
    use_independent_chat_permissions: true,
  });

  await env.VALID.put(String(userId), JSON.stringify(userMeta(user)));

  let restored = 0;
  let joinTime = null;
  const pending = await readPending(env, userId);
  if (pending) {
    if (pending.join_time) joinTime = new Date(pending.join_time);
    if (storageConfigured(env) && Array.isArray(pending.stored_messages)) {
      for (const m of pending.stored_messages) {
        try {
          await api(env, "forwardMessage", {
            chat_id: m.original_chat_id,
            from_chat_id: env.STORAGE_CHANNEL_ID,
            message_id: m.message_id,
          });
          await api(env, "deleteMessage", {
            chat_id: env.STORAGE_CHANNEL_ID,
            message_id: m.message_id,
          });
          restored += 1;
        } catch (e) {
          log(`restore msg ${m.message_id} failed: ${e.message}`);
        }
      }
    }
  }
  await env.PENDING.delete(String(userId));
  return { restored, joinTime };
}

// ---------------------------------------------------------------- 群消息: 未验证用户触发

async function handleGroupMessage(env, update) {
  const msg = update.message;
  const chat = msg.chat;
  if (!isTargetChat(env, chat.id)) return;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const user = msg.from;
  if (!user || user.is_bot) return;

  const text = (msg.text || "").trim();
  if (text.startsWith("/")) return; // 命令不触发验证 (对齐 filters.COMMAND 排除)
  // 跳过服务消息 (入群/退群/置顶等无内容消息)
  const hasContent =
    text || msg.caption || msg.photo || msg.video || msg.document || msg.voice ||
    msg.audio || msg.video_note || msg.animation || msg.sticker;
  if (!hasContent) return;

  if (await isValidUser(env, user.id)) return; // 已验证, 放行

  // 1. 禁言 (幂等)
  await api(env, "restrictChatMember", {
    chat_id: chat.id,
    user_id: user.id,
    permissions: MUTE_PERMISSIONS,
    use_independent_chat_permissions: true,
  });

  // 2. 转发原消息到仓库频道
  let storedId = null;
  if (storageConfigured(env)) {
    try {
      const f = await api(env, "forwardMessage", {
        chat_id: env.STORAGE_CHANNEL_ID,
        from_chat_id: chat.id,
        message_id: msg.message_id,
      });
      storedId = f.message_id;
    } catch (e) {
      log(`forward to storage failed: ${e.message}`);
    }
  }

  // 3. 删除群内原消息
  try {
    await api(env, "deleteMessage", { chat_id: chat.id, message_id: msg.message_id });
  } catch (e) {
    log(`delete original failed: ${e.message}`);
  }

  // 4. 记 pending (合并已有记录, 刷新 TTL)
  const pending = (await readPending(env, user.id)) || {
    join_time: new Date().toISOString(),
    stored_messages: [],
  };
  if (storedId) {
    pending.stored_messages.push({ message_id: storedId, original_chat_id: chat.id });
  }
  await env.PENDING.put(String(user.id), JSON.stringify(pending), {
    expirationTtl: PENDING_TTL_SECONDS,
  });

  // 5. 群内警告 (不自动删)
  const username = await botUsername(env);
  await api(env, "sendMessage", {
    chat_id: chat.id,
    text:
      `⚠️ ${mention(user)} 你未完成验证\n` +
      `🔒 已暂时禁言\n` +
      `💬 请私聊机器人 <a href="https://t.me/${username}">@${username}</a> 并发送 /start 完成验证`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  // 还有一个方案是设置 telegram group welcome message, 这样不会对其它群友造成影响
  // https://zelikk.blogspot.com/2026/09/telegram-group-welcome-message.html
  
  log(`muted+stored user=${user.id} chat=${chat.id} msg=${msg.message_id}`);
}

// ---------------------------------------------------------------- 私聊

// 私聊 /start
async function handleStart(env, user) {
  if (!isTargetChat(env, env.CHAT_ID)) {
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: "⚠️ 机器人尚未完成配置(CHAT_ID 未设置), 请联系群管理员。",
    });
    return;
  }
  // 老号 / 不在群里 -> 只回简介 (对齐 VPS: 非待验证用户 /start 不进验证流程)
  if (isLegacy(user.id) || !(await isInGroup(env, env.CHAT_ID, user.id))) {
    await api(env, "sendMessage", { chat_id: user.id, text: INTRO_TEXT });
    return;
  }
  const pending = await readPending(env, user.id);
  if (pending) {
    const type = questionType(user.id);
    const title = await chatTitle(env);
    await api(env, "sendMessage", {
      chat_id: user.id,
      text:
        `👋 欢迎！你正在验证 <b>${escapeHtml(title)}</b> 中的发言权限\n\n` +
        `${QUESTION_TEXT[type]}\n\n请直接输入答案`,
      parse_mode: "HTML",
    });
    log(`quiz served user=${user.id} type=${type}`);
    return;
  }
  if (await isValidUser(env, user.id)) {
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: "✅ 你已通过验证，可以直接在群组中发言了。",
    });
    return;
  }
  await api(env, "sendMessage", { chat_id: user.id, text: INTRO_TEXT });
}

// 私聊答题
async function handleAnswer(env, user, text) {
  if (!isTargetChat(env, env.CHAT_ID)) return; // 未配置: 不判分不放行
  const pending = await readPending(env, user.id);
  if (!pending) return; // 不在待验证列表: 忽略 (对齐 VPS)
  if (isLegacy(user.id)) return;
  if (await isValidUser(env, user.id)) return; // 已放行, 防重复处理

  const type = questionType(user.id);
  let correct;
  try {
    correct = await computeAnswer(env, type);
  } catch (e) {
    // rss 暂时抓不到: 不出题不判分, 让用户稍后重试
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: `⚠️ 暂时无法获取题目，请稍后重发消息再试。\n(${String(e.message || e).slice(0, 120)})`,
    });
    return;
  }

  if (!checkAnswer(correct, text)) {
    await api(env, "sendMessage", {
      chat_id: user.id,
      text: `❌ 答案错误，请重试！\n\n${QUESTION_TEXT[type]}`,
    });
    log(`wrong answer user=${user.id}`);
    return;
  }

  // 通过: 解除禁言 + 白名单 + 恢复消息
  const { restored, joinTime } = await verifySuccess(env, user.id, user);

  const secs =
    joinTime && !Number.isNaN(joinTime.getTime())
      ? Math.max(0, Math.round((Date.now() - joinTime.getTime()) / 1000))
      : null;

  await api(env, "sendMessage", {
    chat_id: user.id,
    text:
      `✅ 验证成功！\n\n` +
      (secs != null ? `用时：${secs}秒\n` : "") +
      `你现在可以在群组中发言了。`,
  });

  const username = await botUsername(env);
  await api(env, "sendMessage", {
    chat_id: env.CHAT_ID,
    text: `✅ ${mention(user)} 已通过验证${restored > 0 ? `（已恢复 ${restored} 条消息）` : ""}`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  log(`verified user=${user.id} type=${type} restored=${restored}`);
}

// ---------------------------------------------------------------- 管理员命令

// 群内 /add_valid_user <user_id>: 管理员对 pending 用户手动放行
async function handleAdminVerify(env, update, arg) {
  const chat = update.message.chat;
  const from = update.message.from;
  if (!isTargetChat(env, chat.id)) return;

  const self = await api(env, "getChatMember", { chat_id: chat.id, user_id: from.id });
  if (!["administrator", "creator"].includes(self.status)) {
    await api(env, "sendMessage", {
      chat_id: chat.id,
      reply_to_message_id: update.message.message_id,
      text: "❌ 只有管理员可以使用此命令。",
    });
    return;
  }
  if (!arg || !/^\d+$/.test(arg)) {
    await api(env, "sendMessage", {
      chat_id: chat.id,
      reply_to_message_id: update.message.message_id,
      text: "用法：/add_valid_user <user_id>",
    });
    return;
  }

  const targetId = Number(arg);
  const pending = await readPending(env, targetId);
  if (!pending) {
    await api(env, "sendMessage", {
      chat_id: chat.id,
      reply_to_message_id: update.message.message_id,
      text: "❌ 该用户不在待验证列表中",
    });
    return;
  }

  let target;
  try {
    target = (await api(env, "getChatMember", { chat_id: chat.id, user_id: targetId })).user;
  } catch {
    target = { id: targetId, first_name: `用户${targetId}`, username: "" };
  }

  const { restored } = await verifySuccess(env, targetId, target);
  await api(env, "sendMessage", {
    chat_id: chat.id,
    reply_to_message_id: update.message.message_id,
    text: `✅ 已手动验证用户 ${targetId}（恢复 ${restored} 条消息）`,
  });
  log(`admin verified user=${targetId} by=${from.id}`);
}

// ---------------------------------------------------------------- 分发

async function dispatch(env, update) {
  const msg = update.message;
  if (!msg || msg.from?.is_bot) return;
  const user = msg.from;
  const text = (msg.text || "").trim();

  // 群内命令
  if (msg.chat?.type !== "private") {
    if (text.startsWith("/add_valid_user")) {
      await handleAdminVerify(env, update, text.split(/\s+/)[1]);
      return;
    }
    await handleGroupMessage(env, update);
    return;
  }

  // 私聊
  if (text.startsWith("/start")) {
    await handleStart(env, user);
    return;
  }
  if (text) {
    await handleAnswer(env, user, text);
  }
}

// ---------------------------------------------------------------- webhook 自注册
//
// SECRET_TOKEN 保存在 Worker 内 (wrangler secret put SECRET_TOKEN), 不经过 query。
// 管理路径:
//   GET https://<worker>/registerWebhook   -> setWebhook(url=<worker>/webhook,
//        secret_token=env.SECRET_TOKEN, allowed_updates=["message"]); ?drop=1 附带清队列
//   GET https://<worker>/unRegisterWebhook -> deleteWebhook(?drop=1)
// 投递路径: POST /webhook, 以 X-Telegram-Bot-Api-Secret-Token 头比对 env.SECRET_TOKEN。

async function registerWebhook(request, env) {
  if (!env.SECRET_TOKEN) {
    return Response.json({ ok: false, description: "SECRET_TOKEN not configured" }, { status: 500 });
  }
  const url = new URL(request.url);
  const result = await api(env, "setWebhook", {
    url: `${url.protocol}//${url.host}/webhook`,
    secret_token: env.SECRET_TOKEN,
    allowed_updates: ["message"],
    drop_pending_updates: url.searchParams.get("drop") === "1",
  });
  return Response.json({ ok: true, webhook_url: `${url.protocol}//${url.host}/webhook`, result });
}

async function unRegisterWebhook(request, env) {
  const url = new URL(request.url);
  const result = await api(env, "deleteWebhook", {
    drop_pending_updates: url.searchParams.get("drop") === "1",
  });
  const info = await api(env, "getWebhookInfo", {});
  return Response.json({ ok: true, result, webhook_info_url: info.url || null });
}

// ---------------------------------------------------------------- 入口

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/registerWebhook") return registerWebhook(request, env);
    if (url.pathname === "/unRegisterWebhook") return unRegisterWebhook(request, env);

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }
    // secret 未配置时宁可拒绝所有投递, 也不裸奔
    if (
      !env.SECRET_TOKEN ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.SECRET_TOKEN
    ) {
      return new Response("forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    // 业务处理放后台, 立即回 200 (Telegram 对非 2xx/超时会重投)
    ctx.waitUntil(
      dispatch(env, update).catch((e) => log(`dispatch error: ${String(e.stack || e)}`))
    );
    return new Response("ok");
  },
};

// 导出纯函数仅供本地测试 (test.js); Worker 部署不受影响
export { dispatch, questionType, normalize, checkAnswer, parseRssTitle, isValidUser, MUTE_PERMISSIONS };
