import { Bot, InlineKeyboard, InputFile } from "grammy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { logger } from "./lib/logger";
import { voiceManager } from "./voice_manager";

const execFileAsync = promisify(execFile);

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");

// Owner user ID — only this user can use /qr
const OWNER_ID = parseInt(process.env["OWNER_ID"] || "0");

const bot = new Bot(BOT_TOKEN);

// ─── State ─────────────────────────────────────────────────────────────────

interface PlayInfo {
  videoId: string;
  title: string;
  uploader: string;
  filePath: string;
  msgId?: number;
  isPhoto: boolean;   // whether status message is a photo or text
  volume: number;     // 0-200
  repeatCount: number;
}

const nowPlayingUser = new Map<number, number>();   // chatId -> userId who started
const nowPlayingInfo = new Map<number, PlayInfo>(); // chatId -> song details
const pendingQR      = new Map<number, number>();   // userId -> chatId (waiting for scan)

// ─── Permission helpers ─────────────────────────────────────────────────────

async function isGroupAdmin(chatId: number, userId: number, api: Bot["api"]): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

async function canStop(chatId: number, userId: number, api: Bot["api"]): Promise<boolean> {
  // Owner always can
  if (OWNER_ID > 0 && userId === OWNER_ID) return true;
  // Whoever started the song
  const startedBy = nowPlayingUser.get(chatId);
  if (!startedBy || userId === startedBy) return true;
  // Group admins
  return isGroupAdmin(chatId, userId, api);
}

// ─── Keyboard helpers ───────────────────────────────────────────────────────

function buildNowPlayingKeyboard(chatId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("⏹ وقف", `vcstop:${chatId}`)
    .row()
    .text("🔉 -20%", `vcvol:${chatId}:-20`)
    .text("🔊 +20%", `vcvol:${chatId}:+20`)
    .row()
    .text("🔁 مرة", `vcrep:${chatId}:1`)
    .text("🔁 مرتين", `vcrep:${chatId}:2`)
    .text("🔁 ثلاث", `vcrep:${chatId}:3`);
}

function buildNowPlayingCaption(info: PlayInfo): string {
  let text = `🎵 *يشغّل الآن في المكالمة*\n\n${info.title}\n👤 ${info.uploader}\n\n🔊 الصوت: ${info.volume}%`;
  if (info.repeatCount > 0) text += `\n🔁 تكرار: ${info.repeatCount} ${info.repeatCount === 1 ? "مرة" : "مرات"}`;
  return text;
}

async function editNowPlaying(
  chatId: number,
  msgId: number,
  isPhoto: boolean,
  caption: string,
  keyboard: InlineKeyboard,
  api: Bot["api"],
) {
  if (isPhoto) {
    await api.editMessageCaption(chatId, msgId, {
      caption,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }).catch(async () => {
      await api.editMessageText(chatId, msgId, caption, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      }).catch(() => {});
    });
  } else {
    await api.editMessageText(chatId, msgId, caption, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }).catch(() => {});
  }
}

// ─── YouTube helpers ────────────────────────────────────────────────────────

type VideoResult = { id: string; title: string; duration: string; uploader: string };

async function searchYouTube(query: string, limit = 5): Promise<VideoResult[]> {
  const { stdout } = await execFileAsync("yt-dlp", [
    `ytsearch${limit}:${query}`,
    "--print", "%(id)s|||%(title)s|||%(duration_string)s|||%(uploader)s",
    "--no-download", "--no-playlist", "--socket-timeout", "15", "--quiet",
  ]);
  return stdout.trim().split("\n")
    .filter(l => l.includes("|||"))
    .map(l => {
      const p = l.split("|||");
      return { id: p[0].trim(), title: p[1].trim(), duration: p[2].trim(), uploader: p[3].trim() };
    });
}

async function downloadAudio(videoId: string): Promise<string> {
  const outTemplate = `${tmpdir()}/tg_${videoId}_${Date.now()}.%(ext)s`;
  await execFileAsync("yt-dlp", [
    `https://www.youtube.com/watch?v=${videoId}`,
    "-x", "--audio-format", "mp3", "--audio-quality", "128K",
    "-o", outTemplate, "--no-playlist", "--socket-timeout", "30", "--quiet",
  ]);
  return outTemplate.replace("%(ext)s", "mp3");
}

// ─── Send audio (يوت/بحث) ─────────────────────────────────────────────────

async function sendAudioFile(
  chatId: number,
  videoId: string,
  title: string,
  uploader: string,
  api: Bot["api"],
) {
  const statusMsg = await api.sendMessage(chatId, `⏳ جارٍ تحميل: ${title}`);
  let filePath: string | null = null;
  try {
    filePath = await downloadAudio(videoId);
    if (!existsSync(filePath)) throw new Error("File not found");
    const { createReadStream } = await import("node:fs");
    await api.sendAudio(chatId, new InputFile(createReadStream(filePath), `${title.slice(0, 50)}.mp3`), {
      title: title.slice(0, 64),
      performer: uploader.slice(0, 64),
      caption: `🎵 ${title}\n👤 ${uploader}`,
    });
    await api.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
  } catch (err) {
    logger.error({ err, videoId }, "Download/send failed");
    await api.editMessageText(chatId, statusMsg.message_id, "❌ فشل التحميل، جرب أغنية ثانية.").catch(() => {});
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ─── Play in voice call (شغل) ──────────────────────────────────────────────

async function playInCall(
  chatId: number,
  videoId: string,
  title: string,
  uploader: string,
  userId: number,
  api: Bot["api"],
) {
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  let statusMsgId: number | undefined;
  let isPhoto = false;
  let filePath: string | null = null;

  try {
    // Send thumbnail loading message
    try {
      const ph = await api.sendPhoto(chatId, thumbUrl, {
        caption: `⏳ جارٍ التحميل...\n\n🎵 *${title}*\n👤 ${uploader}`,
        parse_mode: "Markdown",
      });
      statusMsgId = ph.message_id;
      isPhoto = true;
    } catch {
      const msg = await api.sendMessage(chatId, `⏳ جارٍ التحميل...\n🎵 ${title}`);
      statusMsgId = msg.message_id;
      isPhoto = false;
    }

    filePath = await downloadAudio(videoId);
    if (!existsSync(filePath)) throw new Error("File not found after download");

    const result = await voiceManager.joinAndPlay(chatId, filePath);
    if (!result.ok) throw new Error((result.error as string) ?? "Unknown error");

    const info: PlayInfo = {
      videoId, title, uploader, filePath,
      msgId: statusMsgId, isPhoto,
      volume: 100, repeatCount: 0,
    };
    nowPlayingUser.set(chatId, userId);
    nowPlayingInfo.set(chatId, info);

    await editNowPlaying(chatId, statusMsgId!, isPhoto,
      buildNowPlayingCaption(info), buildNowPlayingKeyboard(chatId), api);

  } catch (err) {
    logger.error({ err }, "Voice call play failed");
    const errText = `❌ فشل التشغيل في المكالمة:\n${(err as Error).message}`;
    if (statusMsgId) {
      if (isPhoto) {
        await api.editMessageCaption(chatId, statusMsgId, { caption: errText }).catch(() => {});
      } else {
        await api.editMessageText(chatId, statusMsgId, errText).catch(() => {});
      }
    } else {
      await api.sendMessage(chatId, errText).catch(() => {});
    }
    if (filePath && existsSync(filePath)) await unlink(filePath).catch(() => {});
  }
}

// ─── Stop helper ─────────────────────────────────────────────────────────

async function stopCall(chatId: number, api: Bot["api"]): Promise<{ ok: boolean; error?: string }> {
  const result = await voiceManager.stop(chatId);
  if (result.ok) {
    const info = nowPlayingInfo.get(chatId);
    nowPlayingUser.delete(chatId);
    nowPlayingInfo.delete(chatId);
    if (info?.filePath && existsSync(info.filePath)) {
      await unlink(info.filePath).catch(() => {});
    }
    if (info?.msgId) {
      const stopCap = `⏹ توقّف:\n${info.title}`;
      if (info.isPhoto) {
        await api.editMessageCaption(chatId, info.msgId, {
          caption: stopCap,
          reply_markup: new InlineKeyboard(),
        }).catch(() => {});
      } else {
        await api.editMessageText(chatId, info.msgId, stopCap, {
          reply_markup: new InlineKeyboard(),
        }).catch(() => {});
      }
    }
  }
  return result;
}

// ─── Commands ───────────────────────────────────────────────────────────────

bot.command("start", (ctx) =>
  ctx.reply(
    "مرحباً! 🎵\n\n*أوامر البوت:*\n\n" +
    "🎵 `يوت [أغنية]` — تحميل وإرسال الأغنية\n" +
    "🔍 `بحث [أغنية]` — بحث وعرض نتائج للاختيار\n" +
    "📞 `شغل [أغنية]` — تشغيل في مكالمة المجموعة\n" +
    "⏹ `وقف` — إيقاف التشغيل (من شغّلها فقط)\n\n" +
    "ملاحظة: يجب أن تكون في المكالمة لتشغيل أغنية",
    { parse_mode: "Markdown" },
  ),
);

// /qr — private chat only, or owner only
bot.command("qr", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId) return;

  // Restrict: private chat only OR must be owner
  const isPrivate = ctx.chat.type === "private";
  const isOwner = OWNER_ID > 0 && userId === OWNER_ID;
  if (!isPrivate && !isOwner) {
    return ctx.reply("❌ هذا الأمر متاح في المحادثة الخاصة مع البوت فقط.");
  }

  if (!voiceManager.isReady()) {
    return ctx.reply("⏳ خدمة المكالمات لم تبدأ بعد، انتظر لحظة وحاول مجدداً.");
  }

  await ctx.reply("🔄 جارٍ إنشاء رمز QR...");
  const result = await voiceManager.qrLogin();
  if (!result.ok || !result.url) {
    return ctx.reply(`❌ فشل إنشاء رمز QR: ${result.error ?? "خطأ غير معروف"}`);
  }

  const qrUrl = result.url as string;
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrUrl)}`;

  try {
    await ctx.replyWithPhoto(qrImageUrl, {
      caption:
        "📱 *امسح هذا الرمز بتطبيق تلغرام*\n\n" +
        "الإعدادات ← الأجهزة ← ربط جهاز جديد\n\n" +
        "⏳ الرمز صالح لمدة دقيقتين.",
      parse_mode: "Markdown",
    });
    pendingQR.set(userId, ctx.chat.id);
  } catch (err) {
    logger.error({ err }, "Failed to send QR photo");
    await ctx.reply(
      `📱 *رابط تسجيل الدخول:*\n\`${qrUrl}\`\n\n⏳ الرمز صالح لمدة دقيقتين.`,
      { parse_mode: "Markdown" },
    );
    pendingQR.set(userId, ctx.chat.id);
  }
});

bot.command("status", async (ctx) => {
  if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
  const result = await voiceManager.checkSession();
  if (result.ok) {
    await ctx.reply(`✅ الحساب متصل: *${result.name}* (${result.phone})`, { parse_mode: "Markdown" });
  } else {
    await ctx.reply("❌ الحساب غير مسجل. راسل البوت بـ /qr في المحادثة الخاصة.");
  }
});

// ─── Text handler ────────────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text.trim();
  const chatId = ctx.chat.id;
  const userId = ctx.from?.id ?? 0;

  // ── يوت ──
  if (text.startsWith("يوت ") || text === "يوت") {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ اكتب اسم الأغنية بعد *يوت*", { parse_mode: "Markdown" });
    await ctx.reply(`🔍 أبحث عن: ${query}`);
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) return ctx.reply("❌ ما لقيت نتائج.");
      const top = results[0];
      await sendAudioFile(chatId, top.id, top.title, top.uploader, ctx.api);
    } catch (err) {
      logger.error({ err }, "يوت error");
      await ctx.reply("❌ صار خطأ، جرب مرة ثانية.");
    }
    return;
  }

  // ── بحث ──
  if (text.startsWith("بحث ") || text === "بحث") {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ اكتب اسم الأغنية بعد *بحث*", { parse_mode: "Markdown" });
    const searchMsg = await ctx.reply(`🔍 أبحث عن: ${query}`);
    try {
      const results = await searchYouTube(query, 5);
      if (!results.length) {
        await ctx.api.editMessageText(chatId, searchMsg.message_id, "❌ ما لقيت نتائج.");
        return;
      }
      await ctx.api.deleteMessage(chatId, searchMsg.message_id).catch(() => {});
      const keyboard = new InlineKeyboard();
      for (const v of results) {
        const label = `${v.title.slice(0, 33)} [${v.duration}]`;
        keyboard.text(label, `dl:${v.id}:${v.uploader.slice(0, 18)}:${v.title.slice(0, 28)}`).row();
      }
      await ctx.reply(`🎵 *نتائج:* ${query}\n\nاختر أغنية:`, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } catch (err) {
      logger.error({ err }, "بحث error");
      await ctx.api.editMessageText(chatId, searchMsg.message_id, "❌ صار خطأ.").catch(() => {});
    }
    return;
  }

  // ── شغل (مكالمة) ──
  if (text.startsWith("شغل ") || text === "شغل") {
    const query = text.slice(4).trim();
    if (!query) return ctx.reply("⚠️ اكتب اسم الأغنية بعد *شغل*", { parse_mode: "Markdown" });
    if (!voiceManager.isReady()) {
      return ctx.reply("❌ خدمة المكالمات غير متاحة. تأكد من تسجيل الدخول أولاً.");
    }

    // Check that user is in the voice call
    const participantCheck = await voiceManager.checkParticipant(chatId, userId);
    if (!participantCheck.ok) {
      return ctx.reply("❌ لا توجد مكالمة صوتية نشطة في هذه المجموعة.");
    }
    if (!participantCheck.in_call) {
      return ctx.reply("❌ يجب أن تكون في المكالمة الصوتية لتشغيل أغنية. انضم أولاً ثم اطلب.");
    }

    await ctx.reply(`🔍 أبحث عن: ${query}`);
    try {
      const results = await searchYouTube(query, 1);
      if (!results.length) return ctx.reply("❌ ما لقيت نتائج.");
      const top = results[0];
      await playInCall(chatId, top.id, top.title, top.uploader, userId, ctx.api);
    } catch (err) {
      logger.error({ err }, "شغل error");
      await ctx.reply("❌ صار خطأ.");
    }
    return;
  }

  // ── وقف ──
  if (text === "وقف") {
    if (!voiceManager.isReady()) return ctx.reply("❌ خدمة المكالمات غير متاحة.");
    if (!(await canStop(chatId, userId, ctx.api))) {
      return ctx.reply("❌ فقط من شغّل الأغنية أو المشرفين يمكنهم إيقافها.");
    }
    const result = await stopCall(chatId, ctx.api);
    if (result.ok) {
      await ctx.reply("⏹ تم إيقاف التشغيل.");
    } else {
      await ctx.reply(`❌ ${result.error}`);
    }
    return;
  }
});

// ─── Callback: Download ────────────────────────────────────────────────────

bot.callbackQuery(/^dl:([^:]+):([^:]+):(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "⏳ جارٍ التحميل..." });
  const [, videoId, uploader, title] = ctx.match;
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  await sendAudioFile(chatId, videoId, title, uploader, ctx.api);
});

// ─── Callback: Stop voice call ─────────────────────────────────────────────

bot.callbackQuery(/^vcstop:(-?\d+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1]);
  const userId = ctx.from.id;

  if (!(await canStop(chatId, userId, ctx.api))) {
    return ctx.answerCallbackQuery({
      text: "❌ فقط من شغّل الأغنية أو المشرفين يمكنهم إيقافها.",
      show_alert: true,
    });
  }

  await ctx.answerCallbackQuery({ text: "⏹ جارٍ الإيقاف..." });
  const result = await stopCall(chatId, ctx.api);
  if (!result.ok) {
    await ctx.answerCallbackQuery({ text: `❌ ${result.error}`, show_alert: true });
  }
});

// ─── Callback: Volume ──────────────────────────────────────────────────────

bot.callbackQuery(/^vcvol:(-?\d+):([+-]?\d+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1]);
  const delta  = parseInt(ctx.match[2]);
  const info   = nowPlayingInfo.get(chatId);

  if (!info) {
    return ctx.answerCallbackQuery({ text: "❌ لا يوجد أغنية تشتغل الآن.", show_alert: true });
  }

  const newVol = Math.max(0, Math.min(200, info.volume + delta));
  const result = await voiceManager.setVolume(chatId, newVol);

  if (result.ok) {
    info.volume = (result.volume as number) ?? newVol;
    await ctx.answerCallbackQuery({ text: `🔊 الصوت: ${info.volume}%` });
    if (info.msgId) {
      await editNowPlaying(chatId, info.msgId, info.isPhoto,
        buildNowPlayingCaption(info), buildNowPlayingKeyboard(chatId), ctx.api);
    }
  } else {
    await ctx.answerCallbackQuery({ text: `❌ ${result.error}`, show_alert: true });
  }
});

// ─── Callback: Repeat ─────────────────────────────────────────────────────

bot.callbackQuery(/^vcrep:(-?\d+):(\d+)$/, async (ctx) => {
  const chatId = parseInt(ctx.match[1]);
  const count  = parseInt(ctx.match[2]);
  const info   = nowPlayingInfo.get(chatId);

  if (!info) {
    return ctx.answerCallbackQuery({ text: "❌ لا يوجد أغنية تشتغل الآن.", show_alert: true });
  }

  const result = await voiceManager.setRepeat(chatId, info.filePath, count);

  if (result.ok) {
    info.repeatCount = count;
    const label = count === 1 ? "مرة" : `${count} مرات`;
    await ctx.answerCallbackQuery({ text: `🔁 سيتكرر ${label} بعد انتهائها` });
    if (info.msgId) {
      await editNowPlaying(chatId, info.msgId, info.isPhoto,
        buildNowPlayingCaption(info), buildNowPlayingKeyboard(chatId), ctx.api);
    }
  } else {
    await ctx.answerCallbackQuery({ text: `❌ ${result.error}`, show_alert: true });
  }
});

// ─── Bot startup ──────────────────────────────────────────────────────────

export function startBot() {
  voiceManager.start();

  voiceManager.once("ready", () => {
    logger.info("VoiceService is ready");
    logger.warn("Session restore starting in background...");
  });

  voiceManager.on("session_activated", (msg: { name?: string; phone?: string }) => {
    logger.info({ name: msg.name }, "User session activated");
  });

  // Stream ended — clean up state and update message
  voiceManager.on("stream_ended", async (msg: { chat_id?: number }) => {
    const chatId = msg.chat_id;
    if (!chatId) return;
    const info = nowPlayingInfo.get(chatId);
    nowPlayingUser.delete(chatId);
    nowPlayingInfo.delete(chatId);
    if (!info) return;
    if (info.filePath && existsSync(info.filePath)) {
      await unlink(info.filePath).catch(() => {});
    }
    if (info.msgId) {
      const cap = `✅ انتهت:\n${info.title}`;
      if (info.isPhoto) {
        await bot.api.editMessageCaption(chatId, info.msgId, {
          caption: cap,
          reply_markup: new InlineKeyboard(),
        }).catch(() => {});
      } else {
        await bot.api.editMessageText(chatId, info.msgId, cap, {
          reply_markup: new InlineKeyboard(),
        }).catch(() => {});
      }
    }
  });

  // Repeat playing — update repeat count in message
  voiceManager.on("repeat_playing", async (msg: { chat_id?: number; remaining?: number }) => {
    const chatId = msg.chat_id;
    if (!chatId) return;
    const info = nowPlayingInfo.get(chatId);
    if (!info) return;
    info.repeatCount = (msg.remaining as number) ?? 0;
    if (info.msgId) {
      await editNowPlaying(chatId, info.msgId, info.isPhoto,
        buildNowPlayingCaption(info), buildNowPlayingKeyboard(chatId), bot.api);
    }
  });

  // QR events
  voiceManager.on("qr_logged_in", async (msg: { name?: string; phone?: string; session_string?: string }) => {
    logger.info({ name: msg.name }, "QR login successful");
    for (const [userId, chatId] of pendingQR.entries()) {
      try {
        let text = `✅ تم تسجيل الدخول بنجاح!\n👤 ${msg.name} (${msg.phone})`;
        if (msg.session_string) {
          text +=
            "\n\n💾 *احفظ هذا الـ Session String* في متغيرات البيئة:\n" +
            `\`${msg.session_string}\`\n\n` +
            "المتغير: `TELEGRAM_SESSION_STRING`";
        }
        await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
      } catch (e) {
        logger.error({ e, userId }, "Failed to notify QR login success");
      }
      pendingQR.delete(userId);
    }
  });

  voiceManager.on("qr_timeout", async () => {
    for (const [userId, chatId] of pendingQR.entries()) {
      await bot.api.sendMessage(chatId, "⏰ انتهت صلاحية رمز QR. استخدم /qr مرة أخرى.").catch(() => {});
      pendingQR.delete(userId);
    }
  });

  voiceManager.on("qr_error", async (msg: { error?: string }) => {
    for (const [userId, chatId] of pendingQR.entries()) {
      await bot.api.sendMessage(chatId, `❌ خطأ في تسجيل الدخول: ${msg.error}`).catch(() => {});
      pendingQR.delete(userId);
    }
  });

  bot.start().catch((err) => {
    logger.error({ err }, "Bot launch error");
  });

  process.once("SIGINT",  () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  logger.info("Telegram bot started with voice call support");
}
