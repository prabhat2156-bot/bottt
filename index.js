/**
 * WhatsApp Group Manager Bot — Multi-User Edition
 *
 * NEW:
 *  - Multi-user: each Telegram user connects their own WhatsApp
 *  - Premium system: WA features gated behind premium
 *  - Admin Panel: user list, give/remove/temp premium, ban/unban, broadcast, bot status
 *  - Redeem Key: owner generates timed keys, users redeem for premium
 */

const { Telegraf, Markup } = require("telegraf");
const { connectDB }        = require("./src/db");
const {
  getSession, updateSession, resetSession,
  defaultGroupFlow, defaultFeatureFlow,
} = require("./src/session");
const {
  setCallbacks, getStatus, getPhone, getConnectedCount,
  connectAccount, disconnectAccount, reconnectSavedAccounts,
  createGroup, updateGroupDescription, updateGroupPhoto,
  setDisappearingMessages, promoteToAdmin, setGroupPermissions,
  getGroupInviteLink, joinGroupViaLink,
  getAllGroupsWithDetails,
  leaveGroup, removeAllMembers,
  makeAdminByNumbers,
  getGroupApprovalStatus, setGroupApproval,
  approveAllPending,
  getGroupMembers, getGroupPendingRequests,
  resetGroupInviteLink,
  demoteAdminInGroup,
  getGroupSettings, applyGroupSettings,
  renameGroup,
  addMembersToGroup,
  getGroupInfoFromLink,
  getPendingRawJids,
  resolveVcfPhones,
  numberMatches,
  startAutoAcceptForGroups, stopAutoAcceptForGroups, getAutoAcceptStats,
} = require("./src/whatsapp-manager");
const { UserInfo, RedeemKey } = require("./src/models");
const express = require("express");
const http    = require("http");
const https   = require("https");
const crypto  = require("crypto");

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set!"); process.exit(1); }
const OWNER_ID = parseInt(process.env.OWNER_ID || "0", 10);

const bot        = new Telegraf(TOKEN);
const sleep      = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_SIZE  = 10;
const startTimes = new Map();
const aaLiveIntervals = new Map();
const BOT_START  = Date.now();

// ─── Per-feature delay constants ──────────────────────────────────────────
const D = {
  getLinks:       1500,
  leave:          3000,
  removeMembers:  4000,
  makeAdmin:      3000,
  demoteAdmin:    2500,
  approvalToggle: 2000,
  approvePending: 4500,
  memberList:     1500,
  pendingList:    1500,
  resetLink:      2000,
  changeName:     2000,
  createGroup:    2500,
  joinGroup:      2500,
  addMembers:     2500,
  ctcCheck:       1200,
  vcfAutoMatch:   2000,
  pendingCheck:   1000,
};

// ─── User Helpers ──────────────────────────────────────────────────────────
function isOwner(userId) { return OWNER_ID && Number(userId) === OWNER_ID; }

async function ensureUser(ctx) {
  const u = ctx.from;
  if (!u) return;
  const existing = await UserInfo.findOne({ userId: u.id });
  if (!existing) {
    const refCode = await genReferralCode();
    await UserInfo.create({
      userId:        u.id,
      username:      u.username  || "",
      firstName:     u.first_name || "",
      isPremium:     isOwner(u.id),
      isBanned:      false,
      isAdmin:       false,
      joinedAt:      new Date(),
      referralCode:  refCode,
      referralCount: 0,
      referredBy:    null,
    });
  } else if (!existing.referralCode) {
    const refCode = await genReferralCode();
    await UserInfo.updateOne({ userId: u.id }, { $set: { referralCode: refCode } });
  }
}

async function getUser(userId) {
  if (isOwner(userId)) {
    return { userId, isPremium: true, isBanned: false, isAdmin: true };
  }
  return await UserInfo.findOne({ userId }) || { userId, isPremium: false, isBanned: false, isAdmin: false };
}

async function checkPremiumExpiry(userId) {
  const u = await UserInfo.findOne({ userId });
  if (!u || !u.isPremium || !u.premiumExpiry) return;
  if (new Date() > u.premiumExpiry) {
    await UserInfo.updateOne({ userId }, { $set: { isPremium: false, premiumExpiry: null } });
  }
}

async function isPremium(userId) {
  if (isOwner(userId)) return true;
  await checkPremiumExpiry(userId);
  const u = await getUser(userId);
  return u?.isPremium === true;
}

async function isAdminOrOwner(userId) {
  if (isOwner(userId)) return true;
  const u = await UserInfo.findOne({ userId });
  return u?.isAdmin === true;
}

// ─── User Middleware ────────────────────────────────────────────────────────
bot.use(async (ctx, next) => {
  await ensureUser(ctx).catch(() => {});
  const uid = ctx.from?.id;
  if (!uid) return next();
  if (!isOwner(uid)) {
    const u = await UserInfo.findOne({ userId: uid });
    if (u?.isBanned) {
      if (ctx.callbackQuery) await ctx.answerCbQuery("🚫 You are banned.", { show_alert: true }).catch(() => {});
      else await ctx.reply("🚫 You are banned. Contact the owner.").catch(() => {});
      return;
    }
  }
  return next();
});

// ─── Pairing callbacks (per-user) ─────────────────────────────────────────
const pendingPairingCbs = new Map();
const pendingReadyCbs   = new Map();

setCallbacks({
  onPairingCode: async (uid, code) => {
    const cb = pendingPairingCbs.get(String(uid));
    if (cb) { pendingPairingCbs.delete(String(uid)); await cb(code); }
  },
  onReady: async (uid) => {
    const cb = pendingReadyCbs.get(String(uid));
    if (cb) { pendingReadyCbs.delete(String(uid)); await cb(); }
  },
  onDisconnected: async () => {},
});

// ─── withTimeout / withRetry ────────────────────────────────────────────────
function withTimeout(promise, ms = 15000, label = "Operation") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
async function withRetry(fn, retries = 3, baseDelay = 2000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt < retries) await sleep(Math.round(baseDelay * Math.pow(1.5, attempt)));
      else throw err;
    }
  }
}

// ─── Progress helpers ──────────────────────────────────────────────────────
async function startProgress(ctx, uid, text) {
  const m = await ctx.reply(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[Markup.button.callback("🛑 Cancel", "cancel_exec")]]),
  });
  startTimes.set(uid, Date.now());
  updateSession(uid, { cancelMsgId: m.message_id, cancelPending: false });
  return m;
}
async function editProgress(chatId, msgId, text) {
  try {
    await bot.telegram.editMessageText(chatId, msgId, undefined, text, {
      parse_mode: "Markdown",
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🛑 Cancel", "cancel_exec")]]).reply_markup,
    });
  } catch {}
}
async function doneProgress(chatId, msgId, text) {
  try { await bot.telegram.editMessageText(chatId, msgId, undefined, text, { parse_mode: "Markdown" }); } catch {}
}
bot.action("cancel_exec", async (ctx) => {
  await ctx.answerCbQuery("Cancelling...");
  updateSession(ctx.from.id, { cancelPending: true });
  try { await ctx.editMessageText("🛑 *Cancelling...*", { parse_mode: "Markdown" }); } catch {}
});
function isCancelled(uid) { return getSession(uid).cancelPending === true; }

// ─── Misc helpers ──────────────────────────────────────────────────────────
async function reply(ctx, text, extra = {})       { return await ctx.reply(text, extra); }
async function editOrReply(ctx, text, extra = {}) {
  try { return await ctx.editMessageText(text, extra); }
  catch { return await ctx.reply(text, extra); }
}
function bar(done, total) {
  const p = total > 0 ? Math.round((done / total) * 10) : 0;
  return `[${"█".repeat(p)}${"░".repeat(10 - p)}] ${total > 0 ? Math.round((done / total) * 100) : 0}%`;
}
function elapsed(uid) { const t = startTimes.get(uid); return t ? Math.round((Date.now() - t) / 1000) : 0; }

// ─── Feature Labels ────────────────────────────────────────────────────────
const FEAT_LABEL = {
  get_links: "🔗 Get Links", leave: "🚪 Leave Groups", remove_members: "🧹 Remove Members",
  make_admin: "👑 Make Admin", approval: "🔀 Approval Toggle", approve_pending: "✅ Approve Pending",
  member_list: "📋 Member List", pending_list: "⏳ Pending List", join_groups: "🔗 Join Groups",
  create_groups: "➕ Create Groups", add_members: "➕ Add Members", edit_settings: "⚙️ Edit Settings",
  change_name: "✏️ Change Name", reset_link: "🔄 Reset Link", demote_admin: "⬇️ Demote Admin",
  auto_accept: "⏰ Auto Accept", ctc_checker: "🔍 CTC Checker",
};

// ─── Summary ───────────────────────────────────────────────────────────────
async function sendSummary(ctx, opts) {
  const { feature, total, success, failed, cancelled, extra = [], boxLines = [] } = opts;
  const uid  = ctx.from?.id;
  const secs = uid ? elapsed(uid) : 0;
  if (uid) startTimes.delete(uid);
  const statusLine = cancelled ? "🚫 *Cancelled*" : failed === 0 ? "✅ *All done!*" : `⚠️ *Done with ${failed} failure(s)*`;
  let text = `📊 *${FEAT_LABEL[feature] || feature}*\n━━━━━━━━━━━━━━━━━━━━\n${statusLine}\n━━━━━━━━━━━━━━━━━━━━\nTotal   : ${total}\nSuccess : ${success}\nFailed  : ${failed}\nTime    : ${secs}s\n`;
  if (extra.length) text += `━━━━━━━━━━━━━━━━━━━━\n` + extra.join("\n") + "\n";
  text += `━━━━━━━━━━━━━━━━━━━━`;
  if (text.length > 4000) text = text.slice(0, 3990) + "\n_...more_";
  const replyMarkup = Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]);
  const session = uid ? getSession(uid) : null;
  const cancelMsgId = session?.cancelMsgId;
  if (cancelMsgId && ctx.chat?.id) {
    try {
      await bot.telegram.editMessageText(ctx.chat.id, cancelMsgId, undefined, text, {
        parse_mode: "Markdown", reply_markup: replyMarkup.reply_markup,
      });
      if (uid) updateSession(uid, { cancelMsgId: null });
    } catch { await ctx.reply(text, { parse_mode: "Markdown", ...replyMarkup }); }
  } else { await ctx.reply(text, { parse_mode: "Markdown", ...replyMarkup }); }
  if (boxLines.length) {
    const CHUNK = 50;
    for (let c = 0; c < boxLines.length; c += CHUNK) {
      const chunk = boxLines.slice(c, c + CHUNK).join("\n");
      try { await ctx.reply("```\n" + chunk + "\n```", { parse_mode: "Markdown" }); }
      catch { await ctx.reply(chunk); }
      if (c + CHUNK < boxLines.length) await sleep(400);
    }
  }
}

// ─── VCF / Link Parsers ────────────────────────────────────────────────────
function parseVcf(content) {
  const contacts = [];
  const blocks = content.split(/(?=BEGIN:VCARD)/gi);
  for (const block of blocks) {
    if (!block.toUpperCase().includes("BEGIN:VCARD")) continue;
    const nameMatch = block.match(/^FN:(.+)$/m) || block.match(/^N:([^;\r\n]+)/m);
    const name = nameMatch ? nameMatch[1].trim().replace(/\\/g, "") : "";
    const telMatches = [...block.matchAll(/^TEL[^:]*:([^\r\n]+)/gim)];
    for (const m of telMatches) {
      const digits = m[1].trim().replace(/[\s()\-+]/g, "").replace(/[^0-9]/g, "");
      if (digits.length >= 10) contacts.push({ name, phone: digits });
    }
  }
  return contacts;
}
function extractCodes(text) {
  const matches = [...text.matchAll(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/g)];
  return [...new Set(matches.map((m) => m[1]))];
}
async function downloadFile(ctx, fileId) {
  const u = await ctx.telegram.getFileLink(fileId);
  const r = await fetch(u.href);
  return Buffer.from(await r.arrayBuffer());
}
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d}d ${h % 24}h`;
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
function genKey() { return crypto.randomBytes(8).toString("hex").toUpperCase(); }

// ─── Referral Code Generator ────────────────────────────────────────────────
async function genReferralCode() {
  let code, exists = true;
  while (exists) {
    code  = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars
    exists = await UserInfo.findOne({ referralCode: code });
  }
  return code;
}

// ─── Main Menu ─────────────────────────────────────────────────────────────
async function buildMainMenu(uid, ctx) {
  const prem = await isPremium(uid);
  const adm  = await isAdminOrOwner(uid);
  const c    = getStatus(uid) === "connected";
  const p    = getPhone(uid);
  const b    = (label, cb) => Markup.button.callback(label, (prem && c) ? cb : prem ? "need_connect" : "not_premium");
  const rows = [
    [Markup.button.callback(
      c ? `📱 WhatsApp ✅ +${p}` : prem ? `📱 WhatsApp ❌ Not Connected` : `📱 WhatsApp 🔒 Premium Required`,
      prem ? "menu_account" : "not_premium"
    )],
  ];
  if (prem) {
    rows.push([b("➕ Create Groups", "create_groups_start"), b("🔗 Join Groups", "join_groups_start")]);
    rows.push([b("🔗 Get Links", "feat_getlinks"),          b("🚪 Leave Groups", "feat_leave")]);
    rows.push([b("🧹 Remove Members", "feat_removemem"),    b("👑 Make Admin", "feat_makeadmin")]);
    rows.push([b("⬇️ Demote Admin", "feat_demoteadmin"),   b("🔀 Approval Toggle", "feat_approval")]);
    rows.push([b("✅ Approve Pending", "feat_approvepending"), b("🔄 Reset Link", "feat_resetlink")]);
    rows.push([b("📋 Member List", "feat_memberlist"),      b("➕ Add Members", "feat_addmembers")]);
    rows.push([b("⚙️ Edit Settings", "feat_editsettings"), b("✏️ Change Name", "feat_changename")]);
    rows.push([b("⏰ Auto Accept", "feat_autoaccept"),      b("🔍 CTC Checker", "feat_ctcchecker")]);
    rows.push([Markup.button.callback("📊 My Status", "menu_status")]);
    rows.push([Markup.button.callback("🔗 My Referral Link", "referral_link")]);
  } else {
    rows.push([Markup.button.callback("🔑 Redeem Key", "redeem_key"), Markup.button.callback("💎 Get Premium", "show_premium")]);
    rows.push([Markup.button.callback("🔗 Referral (Free Premium)", "referral_link")]);
    rows.push([Markup.button.callback("📊 My Status", "menu_status")]);
  }
  if (adm) rows.push([Markup.button.callback("⚙️ Admin Panel", "admin_panel")]);
  return Markup.inlineKeyboard(rows);
}

async function sendMainMenu(ctx) {
  const uid = ctx.from?.id;
  updateSession(uid, { cancelPending: false, awaitingVcf: null, adminFlow: null });
  const prem = await isPremium(uid);
  const userName = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "User";
  const c = getStatus(uid) === "connected", p = getPhone(uid);
  const menu = await buildMainMenu(uid, ctx);
  await ctx.reply(
    `🤖 *ᴡꜱ ᴀᴜᴛᴏᴍᴀᴛɪᴏɴ* 🤖\n▰▰▰▰▰▰▰▰▰▰▰▰▰\n\n👋 Hey *${userName}*!\n\n` +
    `╭─── 📡 Status ─────────╮\n│ ${c ? "✅" : prem ? "❌" : "🔒"}  WhatsApp: ${c ? `Connected (+${p})` : prem ? "Not Connected" : "Need Premium"}\n│ 💎 Plan: ${prem ? "Premium ✨" : "Free"}\n╰───────────────────────╯\n\n› Choose an option:`,
    { parse_mode: "Markdown", ...menu }
  );
}

// ─── Referral System ────────────────────────────────────────────────────────
async function processReferral(newUserId, refCode) {
  if (!refCode) return;
  const referrer = await UserInfo.findOne({ referralCode: refCode });
  if (!referrer || referrer.userId === newUserId) return;
  const thisUser = await UserInfo.findOne({ userId: newUserId });
  if (thisUser?.referredBy) return; // already referred before
  // Mark user as referred
  await UserInfo.updateOne({ userId: newUserId }, { $set: { referredBy: referrer.userId } });
  // Give referrer +1 day premium (stacks on top of existing expiry)
  const now        = new Date();
  const curExpiry  = referrer.isPremium && referrer.premiumExpiry && referrer.premiumExpiry > now
    ? referrer.premiumExpiry : now;
  const newExpiry  = new Date(curExpiry.getTime() + 86400 * 1000); // +1 day
  await UserInfo.updateOne(
    { userId: referrer.userId },
    { $set: { isPremium: true, premiumExpiry: newExpiry }, $inc: { referralCount: 1 } }
  );
  // Notify referrer
  try {
    await bot.telegram.sendMessage(
      referrer.userId,
      `🎉 *New Referral!*\n━━━━━━━━━━━━━━━━━━━━\n\n👤 Someone joined via your link!\n🏆 You earned *+1 Day Premium*!\n⏰ Premium until: *${newExpiry.toUTCString()}*`,
      { parse_mode: "Markdown" }
    );
  } catch {}
}

bot.command("referral", async (ctx) => {
  const uid  = ctx.from.id;
  const u    = await UserInfo.findOne({ userId: uid });
  const code = u?.referralCode || "N/A";
  const cnt  = u?.referralCount || 0;
  const me   = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=ref_${code}`;
  await ctx.reply(
    `🔗 *Your Referral Link*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `\`${link}\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 Total referred : *${cnt}*\n` +
    `🏆 Reward per ref  : *+1 Day Premium*\n\n` +
    `_Share this link. When someone starts the bot through it, you automatically get +1 Day Premium!_`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) }
  );
});

bot.action("referral_link", async (ctx) => {
  await ctx.answerCbQuery();
  const uid  = ctx.from.id;
  const u    = await UserInfo.findOne({ userId: uid });
  const code = u?.referralCode || "N/A";
  const cnt  = u?.referralCount || 0;
  const me   = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=ref_${code}`;
  await editOrReply(ctx,
    `🔗 *Your Referral Link*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `\`${link}\`\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 Total referred : *${cnt}*\n` +
    `🏆 Reward per ref  : *+1 Day Premium*\n\n` +
    `_Share this link. When someone starts the bot through it, you automatically get +1 Day Premium!_`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]).reply_markup }
  );
});

// ─── Start ─────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const uid      = ctx.from.id;
  const payload  = ctx.startPayload || "";
  resetSession(uid);
  // Handle referral deep link: /start ref_ABCD1234
  if (payload.startsWith("ref_")) {
    const refCode = payload.slice(4);
    await processReferral(uid, refCode).catch(() => {});
  }
  await sendMainMenu(ctx);
});

bot.command("menu", async (ctx) => {
  updateSession(ctx.from.id, { awaitingPhoneForIndex: null, groupFlow: null, joinFlow: null, featureFlow: null, cancelPending: false, awaitingVcf: null, adminFlow: null });
  await sendMainMenu(ctx);
});

bot.action("need_connect", async (ctx) => { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); });
bot.action("not_premium",  async (ctx) => { await ctx.answerCbQuery("💎 Premium required! Use /start → Redeem Key", { show_alert: true }); });

bot.action("back_menu", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (aaLiveIntervals.has(uid)) { clearInterval(aaLiveIntervals.get(uid)); aaLiveIntervals.delete(uid); }
  updateSession(uid, { awaitingPhoneForIndex: null, groupFlow: null, joinFlow: null, featureFlow: null, cancelPending: false, awaitingVcf: null, adminFlow: null });
  await sendMainMenu(ctx);
});

// ─── Premium/Status pages ──────────────────────────────────────────────────
bot.action("show_premium", async (ctx) => {
  await ctx.answerCbQuery();
  const prem = await isPremium(ctx.from.id);
  await editOrReply(ctx,
    `💎 *Premium Membership*\n━━━━━━━━━━━━━━━━━━━━\n${prem ? "✨ You are *Premium*!\n\n" : ""}*Free Plan:*\n• Cannot use WhatsApp features\n\n*Premium Plan:*\n• ✅ Connect your WhatsApp\n• ✅ All group management tools\n• ✅ Create, leave, manage groups\n• ✅ Auto accept, CTC checker, and more\n\nTo get Premium — ask the owner or use a Redeem Key.`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🔑 Redeem Key", "redeem_key")],
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]).reply_markup }
  );
});

// ─── Shared status builder ─────────────────────────────────────────────────
async function buildStatusText(uid, fromCtx) {
  await checkPremiumExpiry(uid);
  const u    = await UserInfo.findOne({ userId: uid });
  const prem = await isPremium(uid);
  const adm  = await isAdminOrOwner(uid);
  const own  = isOwner(uid);
  const s    = getStatus(uid);
  const p    = getPhone(uid);
  const me   = await bot.telegram.getMe();

  // Role label
  const role = own ? "👑 Owner" : adm ? "🛡️ Admin" : prem ? "💎 Premium" : "🆓 Free";

  // WhatsApp
  const waIcon = s === "connected" ? "✅" : s === "connecting" ? "⏳" : "❌";
  const waLine = s === "connected"
    ? `${waIcon} Connected (+${p})`
    : s === "connecting"
      ? `${waIcon} Connecting…`
      : prem ? `${waIcon} Not Connected` : `🔒 Need Premium`;

  // Premium expiry
  let expiryLine = "";
  if (prem && !own) {
    if (u?.premiumExpiry) {
      const exp = new Date(u.premiumExpiry);
      const diffMs  = exp - Date.now();
      const diffDay = Math.floor(diffMs / 86400000);
      const diffHr  = Math.floor((diffMs % 86400000) / 3600000);
      const diffMin = Math.floor((diffMs % 3600000) / 60000);
      const timeLeft = diffMs <= 0 ? "Expired!" : diffDay > 0 ? `${diffDay}d ${diffHr}h left` : diffHr > 0 ? `${diffHr}h ${diffMin}m left` : `${diffMin}m left`;
      expiryLine = `⏰ Expires : ${exp.toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit", timeZoneName:"short" })}\n⌛ Time Left: ${timeLeft}\n`;
    } else {
      expiryLine = `⏰ Expires : Lifetime\n`;
    }
  } else if (own) {
    expiryLine = `⏰ Expires : Lifetime (Owner)\n`;
  }

  // Referral
  const refCode = u?.referralCode || "N/A";
  const refLink = refCode !== "N/A" ? `https://t.me/${me.username}?start=ref_${refCode}` : "N/A";
  const refCnt  = u?.referralCount || 0;

  // Join date
  const joinDate = u?.joinedAt ? new Date(u.joinedAt).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" }) : "Unknown";

  // Name
  const firstName = u?.firstName || fromCtx?.first_name || "";
  const userName  = u?.username  ? `@${u.username}` : "—";

  let text = `📊 *My Profile & Status*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `👤 Name     : ${firstName}\n`;
  text += `📛 Username : ${userName}\n`;
  text += `🆔 User ID  : \`${uid}\`\n`;
  text += `🎖️ Role     : ${role}\n`;
  text += `📅 Joined   : ${joinDate}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `💎 *Plan & Premium*\n`;
  text += `📦 Plan     : ${prem ? "✨ Premium" : "🆓 Free"}\n`;
  text += expiryLine;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `📱 *WhatsApp*\n`;
  text += `📡 Status   : ${waLine}\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  text += `🔗 *Referral*\n`;
  text += `🏷️ Code     : \`${refCode}\`\n`;
  text += `👥 Referred : *${refCnt}* people\n`;
  text += `🏆 Reward   : +1 Day Premium per referral\n`;
  text += `🔗 Link     : \`${refLink}\`\n`;
  text += `━━━━━━━━━━━━━━━━━━━━━━`;
  return text;
}

bot.action("menu_status", async (ctx) => {
  await ctx.answerCbQuery();
  const uid  = ctx.from.id;
  const text = await buildStatusText(uid, ctx.from);
  await editOrReply(ctx, text, { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([
    [Markup.button.callback("🔗 My Referral Link", "referral_link")],
    [Markup.button.callback("🔄 Refresh", "menu_status"), Markup.button.callback("🏠 Main Menu", "back_menu")],
  ]).reply_markup });
});

bot.command("mystatus", async (ctx) => {
  const uid  = ctx.from.id;
  const text = await buildStatusText(uid, ctx.from);
  await ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard([
    [Markup.button.callback("🔗 My Referral Link", "referral_link")],
    [Markup.button.callback("🔄 Refresh", "menu_status"), Markup.button.callback("🏠 Main Menu", "back_menu")],
  ]) });
});

// ─── Redeem Key (user) ─────────────────────────────────────────────────────
bot.action("redeem_key", async (ctx) => {
  await ctx.answerCbQuery();
  updateSession(ctx.from.id, { adminFlow: { action: "redeem", step: "wait_key" } });
  await editOrReply(ctx,
    `🔑 *Redeem Key*\n━━━━━━━━━━━━━━━━━━━━\nEnter your redeem key:`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "back_menu")]]).reply_markup }
  );
});

bot.command("redeem", async (ctx) => {
  const key = ctx.message.text.split(" ")[1]?.trim();
  if (!key) {
    updateSession(ctx.from.id, { adminFlow: { action: "redeem", step: "wait_key" } });
    await ctx.reply("🔑 *Redeem Key*\n\nSend your key:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "back_menu")]]) });
    return;
  }
  await processRedeemKey(ctx, ctx.from.id, key);
});

async function processRedeemKey(ctx, uid, key) {
  const k = await RedeemKey.findOne({ key: key.trim().toUpperCase() });
  if (!k) { await ctx.reply("❌ Invalid key. Check and try again."); return; }
  if (k.isUsed) { await ctx.reply("❌ Key already used."); return; }
  let expiresAt = null, label = "Permanent";
  if (k.durationSeconds) {
    expiresAt = new Date(Date.now() + k.durationSeconds * 1000);
    label = k.durationLabel;
  }
  await RedeemKey.updateOne({ _id: k._id }, { isUsed: true, redeemedBy: uid, redeemedAt: new Date() });
  await UserInfo.findOneAndUpdate(
    { userId: uid },
    { $set: { isPremium: true, premiumExpiry: expiresAt } },
    { upsert: true }
  );
  try {
    await bot.telegram.sendMessage(OWNER_ID, `🔑 Key redeemed!\nUser: ${uid}\nKey: \`${key}\`\nDuration: ${label}`, { parse_mode: "Markdown" });
  } catch {}
  await ctx.reply(`🎉 *Premium Activated!*\n\n✅ Duration: *${label}*${expiresAt ? `\n⏰ Expires: ${expiresAt.toUTCString()}` : ""}\n\nUse /menu to access all features!`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) }
  );
  updateSession(uid, { adminFlow: null });
}

// ─── Account ───────────────────────────────────────────────────────────────
bot.action("menu_account", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
  const status = getStatus(uid), phone = getPhone(uid);
  if (status === "connected") {
    await editOrReply(ctx,
      `📱 *WhatsApp Account*\n━━━━━━━━━━━━━━━━━━━━\n✅ Connected\n📞 +${phone}\n━━━━━━━━━━━━━━━━━━━━\nLogout?`,
      { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🔌 Logout", "logout_wa")], [Markup.button.callback("🏠 Main Menu", "back_menu")]]).reply_markup }
    );
  } else if (status === "connecting") {
    await editOrReply(ctx,
      `📱 *WhatsApp Account*\n━━━━━━━━━━━━━━━━━━━━\n⏳ Connecting...\n━━━━━━━━━━━━━━━━━━━━`,
      { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🔄 Reset", "reset_wa")], [Markup.button.callback("🏠 Main Menu", "back_menu")]]).reply_markup }
    );
  } else {
    updateSession(uid, { awaitingPhoneForIndex: uid });
    await editOrReply(ctx,
      `📱 *Connect WhatsApp*\n━━━━━━━━━━━━━━━━━━━━\n\nSend your phone number with country code:\n\n*Example:* \`919876543210\`\n\n⚠️ Pairing code expires in 60 seconds!`,
      { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]).reply_markup }
    );
  }
});
bot.action("logout_wa", async (ctx) => {
  await ctx.answerCbQuery("Logging out...");
  await editOrReply(ctx, `⏳ *Logging out...*`, { parse_mode: "Markdown" });
  await disconnectAccount(ctx.from.id); await sleep(800); await sendMainMenu(ctx);
});
bot.action("reset_wa", async (ctx) => {
  await ctx.answerCbQuery("Resetting...");
  await disconnectAccount(ctx.from.id);
  updateSession(ctx.from.id, { awaitingPhoneForIndex: ctx.from.id });
  await editOrReply(ctx,
    `📱 *Connect WhatsApp*\n━━━━━━━━━━━━━━━━━━━━\n\nSend your phone number:\n*Example:* \`919876543210\``,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]).reply_markup }
  );
});

// ══════════════════════════════════════════════════════════════════════════
// ─── ADMIN PANEL ──────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

async function showAdminPanel(ctx) {
  const uid = ctx.from.id;
  if (!(await isAdminOrOwner(uid))) { await ctx.answerCbQuery("⛔ Not allowed.", { show_alert: true }).catch(() => {}); return; }
  const totalUsers   = await UserInfo.countDocuments({});
  const premiumCount = await UserInfo.countDocuments({ isPremium: true });
  const bannedCount  = await UserInfo.countDocuments({ isBanned: true });
  const adminCount   = await UserInfo.countDocuments({ isAdmin: true });
  const totalKeys    = await RedeemKey.countDocuments({});
  const usedKeys     = await RedeemKey.countDocuments({ isUsed: true });
  const totalRefs    = await UserInfo.aggregate([{ $group: { _id: null, total: { $sum: "$referralCount" } } }]);
  const totalRefCnt  = totalRefs[0]?.total || 0;
  const uptime       = fmtUptime(Date.now() - BOT_START);
  const role = isOwner(uid) ? "👑 Owner" : "🛡 Admin";
  const text = `⚙️ *Admin Panel* (${role})\n━━━━━━━━━━━━━━━━━━━━\n👥 Total Users: \`${totalUsers}\`\n💎 Premium: \`${premiumCount}\`\n🛡 Admins: \`${adminCount}\`\n🚫 Banned: \`${bannedCount}\`\n🔑 Keys: \`${usedKeys}/${totalKeys}\` used\n🔗 Total Referrals: \`${totalRefCnt}\`\n⏰ Uptime: \`${uptime}\`\n📱 WA Connected: \`${getConnectedCount()}\``;
  const rows = [
    [Markup.button.callback("👥 User List",       "adm:user_list:0"), Markup.button.callback("📊 Bot Status",     "adm:bot_status")],
    [Markup.button.callback("💎 Give Premium",    "adm:give_premium"),Markup.button.callback("❌ Remove Premium", "adm:remove_premium")],
    [Markup.button.callback("⏰ Temp Premium",    "adm:temp_premium"),Markup.button.callback("🚫 Ban User",        "adm:ban")],
    [Markup.button.callback("✅ Unban User",      "adm:unban"),       Markup.button.callback("📢 Broadcast",       "adm:broadcast")],
    [Markup.button.callback("📩 Send to User",    "adm:send_to_user")],
  ];
  if (isOwner(uid)) {
    rows.push([Markup.button.callback("🔑 Generate Key",  "adm:gen_key"), Markup.button.callback("🔑 Key List", "adm:key_list:0")]);
    rows.push([Markup.button.callback("➕ Add Admin",     "adm:add_admin"), Markup.button.callback("➖ Remove Admin", "adm:remove_admin")]);
  }
  rows.push([Markup.button.callback("🔙 Back", "back_menu")]);
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard(rows).reply_markup }); }
  catch { await ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }); }
}

bot.action("admin_panel", async (ctx) => { await ctx.answerCbQuery(); await showAdminPanel(ctx); });

// Bot status
bot.action("adm:bot_status", async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await isAdminOrOwner(ctx.from.id))) { await ctx.answerCbQuery("⛔ Not allowed.", { show_alert: true }); return; }
  const totalUsers   = await UserInfo.countDocuments({});
  const premiumUsers = await UserInfo.countDocuments({ isPremium: true });
  const uptime       = fmtUptime(Date.now() - BOT_START);
  const connected    = getConnectedCount();
  await editOrReply(ctx,
    `📊 *Bot Status*\n━━━━━━━━━━━━━━━━━━━━\n👥 Users: \`${totalUsers}\`\n💎 Premium: \`${premiumUsers}\`\n📱 WA Connected: \`${connected}\`\n⏰ Uptime: \`${uptime}\`\n🤖 Node.js: \`${process.version}\`\n━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🔃 Refresh", "adm:bot_status")],
      [Markup.button.callback("🔙 Admin Panel", "admin_panel")],
    ]).reply_markup }
  );
});

// User list
bot.action(/^adm:user_list:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await isAdminOrOwner(ctx.from.id))) return;
  const page = parseInt(ctx.match[1]);
  const total = await UserInfo.countDocuments({});
  const users = await UserInfo.find({}).sort({ joinedAt: -1 }).skip(page * 10).limit(10);
  const lines = users.map((u, i) => {
    const flags = [u.isPremium ? "💎" : "🆓", u.isBanned ? "🚫" : "", u.isAdmin ? "🛡" : ""].filter(Boolean).join("");
    return `${page * 10 + i + 1}. \`${u.userId}\` ${u.firstName || u.username || "?"} ${flags}`;
  });
  const nav = [];
  if (page > 0)                     nav.push(Markup.button.callback("◀️ Prev", `adm:user_list:${page - 1}`));
  if ((page + 1) * 10 < total)      nav.push(Markup.button.callback("▶️ Next", `adm:user_list:${page + 1}`));
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback("🔙 Admin Panel", "admin_panel")]);
  await editOrReply(ctx,
    `👥 *User List* (Page ${page + 1})\n━━━━━━━━━━━━━━━━━━━━\nTotal: ${total}\n\n${lines.join("\n") || "No users."}`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard(rows).reply_markup }
  );
});

// Admin action starters
const ADM_ACTIONS = {
  "adm:give_premium":    { action: "give_premium",    step: "wait_uid", prompt: "💎 *Give Premium*\n\nSend the user ID:" },
  "adm:remove_premium":  { action: "remove_premium",  step: "wait_uid", prompt: "❌ *Remove Premium*\n\nSend the user ID:" },
  "adm:temp_premium":    { action: "temp_premium",     step: "wait_uid", prompt: "⏰ *Temp Premium*\n\nSend the user ID:" },
  "adm:ban":             { action: "ban",              step: "wait_uid", prompt: "🚫 *Ban User*\n\nSend the user ID:" },
  "adm:unban":           { action: "unban",            step: "wait_uid", prompt: "✅ *Unban User*\n\nSend the user ID:" },
  "adm:broadcast":       { action: "broadcast",        step: "wait_msg", prompt: "📢 *Broadcast*\n\nSend the message to send to all users:" },
  "adm:send_to_user":    { action: "send_to_user",     step: "wait_uid", prompt: "📩 *Send to User*\n\nSend the target user ID:" },
  "adm:add_admin":       { action: "add_admin",        step: "wait_uid", prompt: "🛡 *Add Admin*\n\nSend the user ID:" },
  "adm:remove_admin":    { action: "remove_admin",     step: "wait_uid", prompt: "➖ *Remove Admin*\n\nSend the user ID:" },
};

Object.entries(ADM_ACTIONS).forEach(([cbData, cfg]) => {
  bot.action(cbData, async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await isAdminOrOwner(ctx.from.id))) return;
    if ((cbData === "adm:add_admin" || cbData === "adm:remove_admin") && !isOwner(ctx.from.id)) {
      await ctx.answerCbQuery("Owner only!", { show_alert: true }); return;
    }
    updateSession(ctx.from.id, { adminFlow: { action: cfg.action, step: cfg.step, data: {} } });
    await editOrReply(ctx, cfg.prompt, { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "admin_panel")]]).reply_markup });
  });
});

// Generate Key (owner only)
bot.action("adm:gen_key", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx.from.id)) { await ctx.answerCbQuery("Owner only!", { show_alert: true }); return; }
  await editOrReply(ctx,
    `🔑 *Generate Redeem Key*\n━━━━━━━━━━━━━━━━━━━━\n*Select duration:*`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("1 Minute",  "genkey:60:1 Minute"),   Markup.button.callback("1 Hour",  "genkey:3600:1 Hour")],
      [Markup.button.callback("1 Day",     "genkey:86400:1 Day"),   Markup.button.callback("7 Days",  "genkey:604800:7 Days")],
      [Markup.button.callback("30 Days",   "genkey:2592000:30 Days"),Markup.button.callback("Permanent","genkey:0:Permanent")],
      [Markup.button.callback("🔙 Admin Panel", "admin_panel")],
    ]).reply_markup }
  );
});

bot.action(/^genkey:(\d+):(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx.from.id)) return;
  const secs   = parseInt(ctx.match[1]);
  const label  = ctx.match[2];
  const key    = genKey();
  await RedeemKey.create({
    key,
    durationSeconds: secs || null,
    durationLabel:   label,
    createdBy:       ctx.from.id,
  });
  await editOrReply(ctx,
    `✅ *Key Generated!*\n━━━━━━━━━━━━━━━━━━━━\n🔑 Key: \`${key}\`\n⏰ Duration: *${label}*\n\nShare this key with the user!`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("🔑 Generate Another", "adm:gen_key")],
      [Markup.button.callback("🔙 Admin Panel", "admin_panel")],
    ]).reply_markup }
  );
});

// Key list (owner only)
bot.action(/^adm:key_list:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isOwner(ctx.from.id)) return;
  const page  = parseInt(ctx.match[1]);
  const total = await RedeemKey.countDocuments({});
  const keys  = await RedeemKey.find({}).sort({ createdAt: -1 }).skip(page * 8).limit(8);
  const lines = keys.map((k, i) => {
    const used = k.isUsed ? `✅ by \`${k.redeemedBy}\`` : "⏳ unused";
    return `${page * 8 + i + 1}. \`${k.key}\` | ${k.durationLabel} | ${used}`;
  });
  const nav = [];
  if (page > 0)                   nav.push(Markup.button.callback("◀️ Prev", `adm:key_list:${page - 1}`));
  if ((page + 1) * 8 < total)    nav.push(Markup.button.callback("▶️ Next", `adm:key_list:${page + 1}`));
  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback("🔙 Admin Panel", "admin_panel")]);
  await editOrReply(ctx,
    `🔑 *Key List* (Page ${page + 1}) — Total: ${total}\n━━━━━━━━━━━━━━━━━━━━\n${lines.join("\n") || "No keys."}`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard(rows).reply_markup }
  );
});

// ═══ GROUP SELECTION ══════════════════════════════════════════════════════
async function showGroupTypeSelect(ctx, feature) {
  const label = FEAT_LABEL[feature] || feature;
  await reply(ctx,
    `${label}\n━━━━━━━━━━━━━━━━━━━━\n*Select groups:*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("🔍 Similar Groups", `gs_similar_${feature}`)],
      [Markup.button.callback("📋 All Groups",      `gs_all_${feature}`)],
      [Markup.button.callback("☑️ Select Groups",   `gs_select_${feature}`)],
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]) }
  );
}

const FEAT_MAP = {
  getlinks: "get_links", leave: "leave", removemem: "remove_members",
  makeadmin: "make_admin", approval: "approval", approvepending: "approve_pending",
  editsettings: "edit_settings", resetlink: "reset_link", demoteadmin: "demote_admin",
  autoaccept: "auto_accept",
};
Object.keys(FEAT_MAP).forEach((key) => {
  bot.action(`feat_${key}`, async (ctx) => {
    await ctx.answerCbQuery();
    const uid = ctx.from.id;
    if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
    if (getStatus(uid) !== "connected") { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); return; }
    const feature = FEAT_MAP[key];
    updateSession(uid, { featureFlow: defaultFeatureFlow(feature), cancelPending: false });
    await showGroupTypeSelect(ctx, feature);
  });
});

bot.action("feat_memberlist", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
  if (getStatus(uid) !== "connected") { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); return; }
  updateSession(uid, { featureFlow: defaultFeatureFlow("member_list"), cancelPending: false });
  await reply(ctx, `📋 *Member List*\n━━━━━━━━━━━━━━━━━━━━\n*What to view?*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("👥 Member Count",     "ml_sub_members")],
      [Markup.button.callback("⏳ Pending Requests", "ml_sub_pending")],
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]) }
  );
});
bot.action("ml_sub_members", async (ctx) => {
  await ctx.answerCbQuery();
  updateSession(ctx.from.id, { featureFlow: { ...getSession(ctx.from.id).featureFlow, feature: "member_list" } });
  await showGroupTypeSelect(ctx, "member_list");
});
bot.action("ml_sub_pending", async (ctx) => {
  await ctx.answerCbQuery();
  updateSession(ctx.from.id, { featureFlow: { ...getSession(ctx.from.id).featureFlow, feature: "pending_list" } });
  await showGroupTypeSelect(ctx, "pending_list");
});

bot.action("feat_addmembers", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
  if (getStatus(uid) !== "connected") { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); return; }
  updateSession(uid, {
    featureFlow: { ...defaultFeatureFlow("add_members"), step: "am_links", links: [], vcfs: [], currentVcfIdx: 0, addMode: "bulk" },
    cancelPending: false,
  });
  await reply(ctx, `➕ *Add Members*\n━━━━━━━━━━━━━━━━━━━━\n\nSend group invite links — one per line:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});

bot.action("feat_changename", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
  if (getStatus(uid) !== "connected") { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); return; }
  updateSession(uid, { featureFlow: { ...defaultFeatureFlow("change_name"), step: "cn_mode" }, cancelPending: false });
  await reply(ctx, `✏️ *Change Name*\n━━━━━━━━━━━━━━━━━━━━\n*Select naming method:*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("🔀 Custom Name",        "cn_random")],
      [Markup.button.callback("📛 Match VCF Filename", "cn_vcf")],
      [Markup.button.callback("🏠 Main Menu",           "back_menu")],
    ]) }
  );
});

bot.action("ctc_start_check", async (ctx) => {
  await ctx.answerCbQuery("Starting...");
  const uid = ctx.from.id, flow = getSession(uid).featureFlow;
  if (!flow || flow.step !== "ctc_vcf_collecting") { await ctx.answerCbQuery("⚠️ No active CTC session.", { show_alert: true }); return; }
  if (!(flow.vcfList || []).length) { await ctx.answerCbQuery("⚠️ Upload at least 1 VCF!", { show_alert: true }); return; }
  updateSession(uid, { featureFlow: { ...flow, step: "ctc_running" }, awaitingVcf: null });
  await ctx.reply(`⏳ *Starting CTC check...*`, { parse_mode: "Markdown" });
  await runCtcChecker(ctx);
});

bot.action("feat_ctcchecker", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
  if (getStatus(uid) !== "connected") { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); return; }
  updateSession(uid, {
    featureFlow: { ...defaultFeatureFlow("ctc_checker"), step: "ctc_links", links: [], vcfList: [], ctcVcfIdx: 0 },
    cancelPending: false,
  });
  await reply(ctx, `🔍 *CTC Checker*\n━━━━━━━━━━━━━━━━━━━━\n\n*Step 1:* Send group invite links — one per line:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});

// ─── Similar Groups ────────────────────────────────────────────────────────
bot.action(/^gs_similar_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Detecting groups...");
  const uid = ctx.from.id, feature = ctx.match[1];
  try {
    const all = await getAllGroupsWithDetails(uid);
    if (!all.length) { await reply(ctx, "❌ No groups found.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]])); return; }
    const wordMap = {};
    for (const g of all) {
      const firstWord = (g.name.trim().split(/\s+/)[0] || g.name).toLowerCase();
      if (!wordMap[firstWord]) wordMap[firstWord] = [];
      wordMap[firstWord].push(g.id);
    }
    const entries = Object.entries(wordMap).sort((a, b) => b[1].length - a[1].length);
    updateSession(uid, { featureFlow: { ...getSession(uid).featureFlow, feature, allGroups: all, wordGroups: wordMap, step: "similar_pick" } });
    const visEntries = entries.slice(0, 20);
    const rows = [];
    for (let i = 0; i < visEntries.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, visEntries.length); j++) {
        const [word, ids] = visEntries[j], idx = entries.findIndex(([w]) => w === word);
        row.push(Markup.button.callback(`${word} (${ids.length})`, `gs_swp_${idx}`));
      }
      rows.push(row);
    }
    rows.push([Markup.button.callback("🔍 Custom Keyword", "gs_sim_custom")]);
    rows.push([Markup.button.callback("🏠 Main Menu", "back_menu")]);
    await reply(ctx, `🔍 *Similar Groups*\n━━━━━━━━━━━━━━━━━━━━\nTotal: *${all.length}* groups\n\n*Auto-detected prefixes:*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) });
  } catch (err) { await reply(ctx, `❌ Error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]])); }
});
bot.action(/^gs_swp_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id, idx = parseInt(ctx.match[1]), flow = getSession(uid).featureFlow;
  const entries = Object.entries(flow.wordGroups || {}).sort((a, b) => b[1].length - a[1].length);
  if (idx >= entries.length) return;
  const [word, ids] = entries[idx], matching = flow.allGroups.filter((g) => ids.includes(g.id));
  updateSession(uid, { featureFlow: { ...flow, selectedIds: ids, keyword: word, step: "confirm" } });
  await reply(ctx,
    `✅ *"${word}" — ${matching.length} group(s):*\n━━━━━━━━━━━━━━━━━━━━\n${matching.slice(0, 20).map((g, i) => `${i + 1}. ${g.name}`).join("\n")}${matching.length > 20 ? `\n_...and ${matching.length - 20} more_` : ""}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("🚀 Proceed", "gs_sim_proceed")],
      [Markup.button.callback("🔙 Back", `gs_similar_${flow.feature}`)],
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]) }
  );
});
bot.action("gs_sim_custom", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  updateSession(ctx.from.id, { featureFlow: { ...flow, step: "similar_query" } });
  await reply(ctx, `🔍 *Custom Keyword*\n━━━━━━━━━━━━━━━━━━━━\nType a keyword to search group names:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});
bot.action(/^gs_all_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Loading groups...");
  const uid = ctx.from.id, feature = ctx.match[1];
  try {
    const groups = await getAllGroupsWithDetails(uid);
    if (!groups.length) { await reply(ctx, "❌ No groups found.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]])); return; }
    updateSession(uid, { featureFlow: { ...getSession(uid).featureFlow, feature, allGroups: groups, selectedIds: groups.map(g => g.id), step: "confirm" } });
    await reply(ctx,
      `✅ *All Groups Selected — ${groups.length} groups*\n━━━━━━━━━━━━━━━━━━━━\n${groups.slice(0, 10).map((g, i) => `${i + 1}. ${g.name}`).join("\n")}${groups.length > 10 ? `\n_...and ${groups.length - 10} more_` : ""}`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🚀 Proceed", "gs_sim_proceed")],
        [Markup.button.callback("🏠 Main Menu", "back_menu")],
      ]) }
    );
  } catch (err) { await reply(ctx, `❌ Error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]])); }
});
bot.action(/^gs_select_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Loading...");
  const uid = ctx.from.id, feature = ctx.match[1];
  try {
    const groups = await getAllGroupsWithDetails(uid);
    if (!groups.length) { await reply(ctx, "❌ No groups found.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]])); return; }
    updateSession(uid, { featureFlow: { ...getSession(uid).featureFlow, feature, allGroups: groups, selectedIds: [], page: 0, step: "select" } });
    await showPaginatedGroups(ctx);
  } catch (err) { await reply(ctx, `❌ Error: ${err.message}`, Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]])); }
});
async function showPaginatedGroups(ctx) {
  const flow = getSession(ctx.from.id).featureFlow;
  const { allGroups, selectedIds, page } = flow;
  const selSet = new Set(selectedIds), totalPages = Math.ceil(allGroups.length / PAGE_SIZE);
  const slice  = allGroups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const rows = [];
  for (let i = 0; i < slice.length; i++) {
    const idx = page * PAGE_SIZE + i, g = slice[i];
    const name = g.name.length > 40 ? g.name.slice(0, 39) + "…" : g.name;
    rows.push([Markup.button.callback(`${selSet.has(g.id) ? "✅" : "◻️"} ${name}`, `gs_tog_${idx}`)]);
  }
  const nav = [];
  if (page > 0)              nav.push(Markup.button.callback("◀️", "gs_prev"));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, "gs_noop"));
  if (page < totalPages - 1) nav.push(Markup.button.callback("▶️", "gs_next"));
  rows.push(nav);
  rows.push([Markup.button.callback(`✅ Confirm (${selSet.size} selected)`, "gs_confirm")]);
  rows.push([Markup.button.callback("🏠 Main Menu", "back_menu")]);
  const text = `☑️ *Select Groups* — Page ${page + 1}/${totalPages}\n━━━━━━━━━━━━━━━━━━━━\nTotal: *${allGroups.length}*  •  Selected: *${selSet.size}*`;
  try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard(rows).reply_markup }); }
  catch { await ctx.reply(text, { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }); }
}
bot.action("gs_noop", async (ctx) => { await ctx.answerCbQuery(); });
bot.action("gs_next", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  if (flow.page < Math.ceil(flow.allGroups.length / PAGE_SIZE) - 1) updateSession(ctx.from.id, { featureFlow: { ...flow, page: flow.page + 1 } });
  await showPaginatedGroups(ctx);
});
bot.action("gs_prev", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  if (flow.page > 0) updateSession(ctx.from.id, { featureFlow: { ...flow, page: flow.page - 1 } });
  await showPaginatedGroups(ctx);
});
bot.action(/^gs_tog_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const idx = parseInt(ctx.match[1]), flow = getSession(ctx.from.id).featureFlow;
  const gid = flow.allGroups[idx]?.id; if (!gid) return;
  const sel = new Set(flow.selectedIds);
  sel.has(gid) ? sel.delete(gid) : sel.add(gid);
  updateSession(ctx.from.id, { featureFlow: { ...flow, selectedIds: [...sel] } });
  await showPaginatedGroups(ctx);
});
bot.action("gs_confirm", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  if (!flow.selectedIds.length) { await ctx.answerCbQuery("⚠️ Select at least 1 group!", { show_alert: true }); return; }
  await onGroupsConfirmed(ctx, flow.feature, flow.selectedIds, flow.allGroups);
});
bot.action("gs_sim_proceed", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  await onGroupsConfirmed(ctx, flow.feature, flow.selectedIds, flow.allGroups);
});

async function onGroupsConfirmed(ctx, feature, selectedIds, allGroups) {
  const uid = ctx.from.id, s = getSession(uid);
  if (feature === "make_admin") {
    updateSession(uid, { featureFlow: { ...s.featureFlow, selectedIds, allGroups, step: "admin_numbers" } });
    await reply(ctx, `👑 *Make Admin*\n━━━━━━━━━━━━━━━━━━━━\n*${selectedIds.length} group(s) selected*\n\nSend phone numbers to make admin — one per line:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
    return;
  }
  if (feature === "demote_admin") {
    updateSession(uid, { featureFlow: { ...s.featureFlow, selectedIds, allGroups, step: "demote_numbers" } });
    await reply(ctx, `⬇️ *Demote Admin*\n━━━━━━━━━━━━━━━━━━━━\n*${selectedIds.length} group(s) selected*\n\nSend admin phone numbers to demote:`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
    return;
  }
  if (feature === "edit_settings") {
    updateSession(uid, { featureFlow: { ...s.featureFlow, selectedIds, allGroups, step: "es_configure", desiredSettings: { announce: null, restrict: null, joinApproval: null, memberAddMode: null } } });
    await showEditSettingsConfig(ctx); return;
  }
  if (feature === "auto_accept") {
    updateSession(uid, { featureFlow: { ...s.featureFlow, selectedIds, allGroups, step: "aa_duration" } });
    await showAutoAcceptDuration(ctx); return;
  }
  updateSession(uid, { featureFlow: { ...s.featureFlow, selectedIds, allGroups } });
  await runFeature(ctx, feature, selectedIds, allGroups, []);
}

// ─── Edit Settings ─────────────────────────────────────────────────────────
function esFmt(val)     { if (val === null || val === undefined) return "Skip"; return val ? "✅ ON" : "❌ OFF"; }
function esFmtSend(val) { if (val === null || val === undefined) return "Skip"; return val === false ? "✅ ON" : "❌ OFF"; }
function settingsKb(d)  {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💬 All Can Send      : ${esFmtSend(d.announce)}`,  "es_tog_announce")],
    [Markup.button.callback(`✏️ Edit Info (lock)  : ${esFmt(d.restrict)}`,      "es_tog_restrict")],
    [Markup.button.callback(`🔐 Join Approval     : ${esFmt(d.joinApproval)}`,  "es_tog_joinApproval")],
    [Markup.button.callback(`➕ All Can Add       : ${esFmt(d.memberAddMode)}`, "es_tog_memberAddMode")],
    [Markup.button.callback("💾 Apply Settings",   "es_apply")],
    [Markup.button.callback("🏠 Main Menu", "back_menu")],
  ]);
}
async function showEditSettingsConfig(ctx) {
  const flow = getSession(ctx.from.id).featureFlow, d = flow.desiredSettings;
  await reply(ctx, `⚙️ *Edit Settings*\n━━━━━━━━━━━━━━━━━━━━\n*${flow.selectedIds.length} group(s) selected*\n\nTap to toggle — cycles: Skip → ON → OFF`,
    { parse_mode: "Markdown", ...settingsKb(d) });
}
["announce", "restrict", "joinApproval", "memberAddMode"].forEach((key) => {
  bot.action(`es_tog_${key}`, async (ctx) => {
    await ctx.answerCbQuery();
    const flow = getSession(ctx.from.id).featureFlow, cur = flow.desiredSettings[key];
    let next;
    if (key === "announce") next = cur === null ? false : cur === false ? true : null;
    else next = cur === null ? true : cur === true ? false : null;
    const newSettings = { ...flow.desiredSettings, [key]: next };
    updateSession(ctx.from.id, { featureFlow: { ...flow, desiredSettings: newSettings } });
    try { await ctx.editMessageReplyMarkup(settingsKb(newSettings).reply_markup); }
    catch { await showEditSettingsConfig(ctx); }
  });
});
bot.action("es_apply", async (ctx) => {
  await ctx.answerCbQuery("Applying...");
  const uid = ctx.from.id, flow = getSession(uid).featureFlow, d = flow.desiredSettings;
  if (d.announce === null && d.restrict === null && d.joinApproval === null && d.memberAddMode === null) {
    await ctx.answerCbQuery("⚠️ No settings selected!", { show_alert: true }); return;
  }
  const sel = flow.allGroups.filter((g) => flow.selectedIds.includes(g.id)), total = sel.length;
  updateSession(uid, { cancelPending: false });
  const pm = await startProgress(ctx, uid, `⚙️ Applying settings — ${total} group(s)...\n${bar(0, total)}`);
  let changed = 0, alreadyOk = 0, failed = 0, cancelled = false;
  for (let i = 0; i < total; i++) {
    if (isCancelled(uid)) { cancelled = true; break; }
    const g = sel[i];
    await editProgress(ctx.chat.id, pm.message_id, `⚙️ Applying settings...\nDone: ${i}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
    try {
      const result = await withRetry(() => applyGroupSettings(uid, g.id, d), 2, 2000);
      if (result.changes.length) changed++; else alreadyOk++;
    } catch { failed++; }
    await sleep(D.approvalToggle);
  }
  await sendSummary(ctx, { feature: "edit_settings", total, success: changed, failed, cancelled,
    extra: [`Total Selected: ${total}`, `Changed       : ${changed}`, `Already OK    : ${alreadyOk}`, `Failed        : ${failed}`] });
  updateSession(uid, { featureFlow: null });
});

// ─── Change Name ────────────────────────────────────────────────────────────
bot.action("cn_random", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  updateSession(ctx.from.id, { featureFlow: { ...flow, step: "cn_random_name", cnMethod: "random" } });
  await reply(ctx, `✏️ *Change Name — Custom*\n━━━━━━━━━━━━━━━━━━━━\n\nType the base name:\n_Example:_ \`Madara\``,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});
bot.action("cn_numbering_yes", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  updateSession(ctx.from.id, { featureFlow: { ...flow, numbering: true, step: "cn_random_links" } });
  await reply(ctx, `✏️ *Numbering: ON*\nNames: _${flow.cnBaseName} 1, ${flow.cnBaseName} 2..._\n\nNow send group invite links (one per line):`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});
bot.action("cn_numbering_no", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  updateSession(ctx.from.id, { featureFlow: { ...flow, numbering: false, step: "cn_random_links" } });
  await reply(ctx, `✏️ *Numbering: OFF*\nAll groups: _${flow.cnBaseName}_\n\nNow send group invite links (one per line):`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});
async function runChangeNameRandom(ctx, links, baseName, numbering) {
  const uid = ctx.from.id, total = links.length;
  updateSession(uid, { cancelPending: false });
  const pm = await startProgress(ctx, uid, `✏️ Renaming ${total} group(s)...\n${bar(0, total)}`);
  let done = 0, failed = 0, cancelled = false;
  const boxLines = [];
  for (let i = 0; i < total; i++) {
    if (isCancelled(uid)) { cancelled = true; break; }
    const code = links[i], newName = numbering ? `${baseName} ${i + 1}` : baseName;
    await editProgress(ctx.chat.id, pm.message_id, `✏️ Renaming...\nDone: ${done}/${total}  ❌ ${failed}\n→ "${newName}"\n${bar(i, total)}`);
    try {
      const info = await withTimeout(withRetry(() => getGroupInfoFromLink(uid, code), 2, 1500), 12000, "GetGroupInfo");
      if (!info) throw new Error("Invalid/expired link");
      await withTimeout(withRetry(() => renameGroup(uid, info.id, newName), 2, 1500), 12000, "RenameGroup");
      done++; boxLines.push(`${info.name} ➡️ ${newName}`);
    } catch (err) { failed++; boxLines.push(`❌ Group ${i + 1}: ${err.message}`); }
    await sleep(D.changeName);
  }
  await sendSummary(ctx, { feature: "change_name", total, success: done, failed, cancelled, boxLines });
  updateSession(uid, { featureFlow: null });
}
bot.action("cn_vcf", async (ctx) => {
  await ctx.answerCbQuery();
  const flow = getSession(ctx.from.id).featureFlow;
  updateSession(ctx.from.id, {
    featureFlow: { ...flow, step: "cn_vcf_collecting", cnMethod: "vcf", vcfList: [] },
    awaitingVcf: { feature: "change_name", step: "cn_vcf" },
  });
  await reply(ctx, `📛 *Change Name — Match VCF Filename*\n━━━━━━━━━━━━━━━━━━━━\n\n• Send VCF files (one or many)\n• Bot scans ALL groups automatically\n• Each group renamed to best matching VCF filename\n\n📎 *Send all VCF files now, then tap Start:*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});
async function showVcfCollectStatus(ctx, vcfList) {
  const lines = vcfList.map((v, i) => `${i + 1}. *${v.name}* — ${v.contacts.length} contacts`).join("\n");
  await reply(ctx, `📛 *VCFs collected: ${vcfList.length}*\n━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━\nSend more VCF files or tap *Start Renaming*:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback(`▶️ Start Renaming (${vcfList.length} VCF${vcfList.length > 1 ? "s" : ""})`, "cn_vcf_start")],
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]) }
  );
}
bot.action("cn_vcf_start", async (ctx) => {
  await ctx.answerCbQuery("Starting...");
  const uid = ctx.from.id, flow = getSession(uid).featureFlow, vcfList = flow.vcfList || [];
  if (!vcfList.length) { await ctx.answerCbQuery("⚠️ Send at least one VCF!", { show_alert: true }); return; }
  updateSession(uid, { awaitingVcf: null });
  await runChangeNameAsVcfAuto(ctx, vcfList);
});
async function runChangeNameAsVcfAuto(ctx, vcfList) {
  const uid = ctx.from.id;
  updateSession(uid, { cancelPending: false });
  const loadMsg = await ctx.reply(`📛 *Loading all groups...*`, { parse_mode: "Markdown" });
  let allGroups;
  try { allGroups = await withRetry(() => getAllGroupsWithDetails(uid)); }
  catch (err) { try { await bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch {} await ctx.reply(`❌ Failed to load groups: ${err.message}`); return; }
  try { await bot.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch {}
  const totalGroups = allGroups.length;
  const resolveMsg = await ctx.reply(`📛 *Resolving ${vcfList.length} VCF(s) via WhatsApp...*`, { parse_mode: "Markdown" });
  const resolvedVcfs = [];
  for (const v of vcfList) {
    const phones = (v.contacts || []).map((c) => c.phone);
    const resolved = phones.length ? await resolveVcfPhones(uid, phones) : [];
    resolvedVcfs.push({ name: v.name, resolved });
    await sleep(300);
  }
  try { await bot.telegram.deleteMessage(ctx.chat.id, resolveMsg.message_id); } catch {}
  const pm = await startProgress(ctx, uid, `📛 Scanning ${totalGroups} group(s)...\nVCFs: ${vcfList.length}\n${bar(0, totalGroups)}`);
  let renamed = 0, skipped = 0, failed = 0, cancelled = false;
  const boxLines = [];
  for (let i = 0; i < totalGroups; i++) {
    if (isCancelled(uid)) { cancelled = true; break; }
    const g = allGroups[i];
    await editProgress(ctx.chat.id, pm.message_id, `📛 Scanning groups...\nRenamed: ${renamed}  Skipped: ${skipped}  ❌ ${failed}\n→ ${g.name}\n${bar(i, totalGroups)}`);
    try {
      const groupJids = new Set(), groupPhones = new Set();
      for (const p of (g.participants || [])) {
        const fields = [p.jid, p.id, p.lid, p.participant, p.userJid].filter((j) => j && typeof j === "string");
        for (const j of fields) {
          const norm = j.replace(/:\d+@/, "@").toLowerCase().trim();
          groupJids.add(norm);
          if (norm.endsWith("@s.whatsapp.net")) { const ph = norm.split("@")[0]; if (ph && ph.length >= 7) groupPhones.add(ph); }
        }
      }
      try {
        const { jids: pendingJids, phones: pendingPhones } = await withTimeout(withRetry(() => getPendingRawJids(uid, g.id), 2, 1500), 10000, "PendingJids");
        pendingJids.forEach((j) => groupJids.add(j));
        pendingPhones.forEach((ph) => groupPhones.add(ph));
      } catch {}
      await sleep(D.pendingCheck);
      let bestVcf = null, bestCount = 0;
      for (const vcf of resolvedVcfs) {
        let count = 0;
        for (const r of vcf.resolved) {
          if ((r.phoneJid && groupJids.has(r.phoneJid)) || (r.lid && groupJids.has(r.lid))) { count++; continue; }
          if (r.phone && groupPhones.has(r.phone)) { count++; continue; }
          if (r.phone && groupPhones.size > 0) { for (const gph of groupPhones) { if (numberMatches(gph, r.phone)) { count++; break; } } }
        }
        if (count > bestCount) { bestCount = count; bestVcf = vcf; }
      }
      if (bestVcf && bestCount > 0) {
        await withTimeout(withRetry(() => renameGroup(uid, g.id, bestVcf.name), 2, 1500), 12000, "RenameGroup");
        renamed++; boxLines.push(`${g.name} ➡️ ${bestVcf.name}`);
      } else { skipped++; }
    } catch (err) { failed++; boxLines.push(`❌ ${g.name}: ${err.message}`); }
    await sleep(D.vcfAutoMatch);
  }
  await sendSummary(ctx, { feature: "change_name", total: totalGroups, success: renamed, failed, cancelled,
    extra: [`Groups scanned : ${totalGroups}`, `Renamed        : ${renamed}`, `No match (skip): ${skipped}`], boxLines });
  updateSession(uid, { featureFlow: null, awaitingVcf: null });
}

// ─── Auto Accept ────────────────────────────────────────────────────────────
async function showAutoAcceptDuration(ctx) {
  const flow = getSession(ctx.from.id).featureFlow;
  await reply(ctx, `⏰ *Auto Accept*\n━━━━━━━━━━━━━━━━━━━━\n*${flow.selectedIds.length} group(s) selected*\n\nSelect duration:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("5 min",  "aa_dur_300"),  Markup.button.callback("10 min", "aa_dur_600")],
      [Markup.button.callback("30 min", "aa_dur_1800"), Markup.button.callback("1 hour", "aa_dur_3600")],
      [Markup.button.callback("2 hrs",  "aa_dur_7200"), Markup.button.callback("6 hrs",  "aa_dur_21600")],
      [Markup.button.callback("✏️ Custom (minutes)", "aa_dur_custom")],
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]) }
  );
}
bot.action(/^aa_dur_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const secs = parseInt(ctx.match[1]), flow = getSession(ctx.from.id).featureFlow;
  updateSession(ctx.from.id, { featureFlow: { ...flow, aaDuration: secs, step: "aa_confirm" } });
  const mins = secs / 60, label = mins >= 60 ? `${mins / 60}h` : `${mins}min`;
  await reply(ctx, `⏰ *Auto Accept — Confirm*\n━━━━━━━━━━━━━━━━━━━━\nGroups   : *${flow.selectedIds.length}*\nDuration : *${label}*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("▶️ Start", "aa_start")],
      [Markup.button.callback("🔙 Change", "aa_back_duration")],
      [Markup.button.callback("🏠 Main Menu", "back_menu")],
    ]) }
  );
});
bot.action("aa_dur_custom", async (ctx) => {
  await ctx.answerCbQuery();
  updateSession(ctx.from.id, { featureFlow: { ...getSession(ctx.from.id).featureFlow, step: "aa_custom_duration" } });
  await reply(ctx, `⏰ *Custom Duration*\n\nSend duration in minutes (e.g. \`120\` for 2 hours):`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});
bot.action("aa_back_duration", async (ctx) => { await ctx.answerCbQuery(); await showAutoAcceptDuration(ctx); });

function buildLiveAutoAcceptText(sel, label, endTime, stats) {
  const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
  const totalAcc  = Object.values(stats).reduce((s, v) => s + (v?.accepted || 0), 0);
  const lines = sel.map((g) => `• ${g.name}: ${stats[g.id]?.accepted || 0}`).slice(0, 15);
  return `⏰ *Auto Accept — Running*\n━━━━━━━━━━━━━━━━━━━━\nDuration : *${label}*\nTime left: *${remaining}s*\nAccepted : *${totalAcc}*\n\n${lines.join("\n")}`;
}
bot.action("aa_start", async (ctx) => {
  await ctx.answerCbQuery("Starting...");
  const uid = ctx.from.id, flow = getSession(uid).featureFlow;
  const secs = flow.aaDuration, mins = secs / 60;
  const label = mins >= 60 ? `${mins / 60}h` : `${mins}min`;
  const sel = (flow.allGroups || []).filter((g) => flow.selectedIds.includes(g.id));
  startAutoAcceptForGroups(uid, flow.selectedIds);
  const endTime = Date.now() + secs * 1000;
  const statusMsg = await ctx.reply(buildLiveAutoAcceptText(sel, label, endTime, getAutoAcceptStats(flow.selectedIds)),
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🛑 Stop", "aa_stop")]]) });
  const liveInterval = setInterval(async () => {
    try {
      await bot.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
        buildLiveAutoAcceptText(sel, label, endTime, getAutoAcceptStats(flow.selectedIds)),
        { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🛑 Stop", "aa_stop")]]).reply_markup });
    } catch {}
  }, 5000);
  aaLiveIntervals.set(uid, liveInterval);
  setTimeout(async () => {
    if (!aaLiveIntervals.has(uid)) return;
    clearInterval(aaLiveIntervals.get(uid)); aaLiveIntervals.delete(uid);
    const stats = getAutoAcceptStats(flow.selectedIds);
    stopAutoAcceptForGroups(flow.selectedIds);
    const totalAccepted = Object.values(stats).reduce((s, v) => s + (v?.accepted || 0), 0);
    const boxLines = sel.map((g) => `${g.name}: ${stats[g.id]?.accepted || 0} accepted`);
    try { await bot.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined,
      `⏰ *Auto Accept — Finished*  ✅ Accepted: *${totalAccepted}*`, { parse_mode: "Markdown" }); } catch {}
    await sendSummary(ctx, { feature: "auto_accept", total: sel.length, success: sel.length, failed: 0, cancelled: false,
      extra: [`Total Groups : ${sel.length}`, `Total Accepted: ${totalAccepted}`, `Duration      : ${label}`], boxLines });
    updateSession(uid, { featureFlow: null });
  }, secs * 1000);
});
bot.action("aa_stop", async (ctx) => {
  await ctx.answerCbQuery("Stopping...");
  const uid = ctx.from.id, flow = getSession(uid).featureFlow;
  if (aaLiveIntervals.has(uid)) { clearInterval(aaLiveIntervals.get(uid)); aaLiveIntervals.delete(uid); }
  if (!flow?.selectedIds) { await sendMainMenu(ctx); return; }
  const stats = getAutoAcceptStats(flow.selectedIds);
  stopAutoAcceptForGroups(flow.selectedIds);
  const totalAccepted = Object.values(stats).reduce((s, v) => s + (v?.accepted || 0), 0);
  const sel = (flow.allGroups || []).filter((g) => flow.selectedIds.includes(g.id));
  const boxLines = sel.map((g) => `${g.name}: ${stats[g.id]?.accepted || 0} accepted`);
  try { await ctx.editMessageText(`🛑 *Auto Accept Stopped*  Total: *${totalAccepted}*`, { parse_mode: "Markdown" }); } catch {}
  await sendSummary(ctx, { feature: "auto_accept", total: sel.length, success: sel.length, failed: 0, cancelled: true,
    extra: [`Total Groups : ${sel.length}`, `Total Accepted: ${totalAccepted}`], boxLines });
  updateSession(uid, { featureFlow: null });
});

// ─── Main Feature Runner ───────────────────────────────────────────────────
async function runFeature(ctx, feature, selectedIds, allGroups, extraNums) {
  const uid = ctx.from.id, sel = allGroups.filter((g) => selectedIds.includes(g.id)), total = sel.length;
  if (!total) { await reply(ctx, "❌ No groups selected."); return; }
  updateSession(uid, { cancelPending: false });

  if (feature === "get_links") {
    const pm = await startProgress(ctx, uid, `🔗 Getting links — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, cancelled = false;
    const results = [], fails = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `🔗 Getting links...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { results.push({ name: g.name, link: await withRetry(() => getGroupInviteLink(uid, g.id)) }); done++; }
      catch { fails.push(g.name); failed++; }
      await sleep(D.getLinks);
    }
    const boxLines = results.map((r) => `${r.name}\n${r.link}`);
    fails.forEach((n) => boxLines.push(`❌ ${n}: failed`));
    await sendSummary(ctx, { feature: "get_links", total, success: done, failed, cancelled,
      extra: [`Total Groups : ${total}`, `Successful   : ${done}`, `Failed       : ${failed}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "leave") {
    const pm = await startProgress(ctx, uid, `🚪 Leaving ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, cancelled = false;
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `🚪 Leaving groups...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { await withRetry(() => leaveGroup(uid, g.id)); done++; }
      catch { failed++; }
      await sleep(D.leave);
    }
    await sendSummary(ctx, { feature, total, success: done, failed, cancelled,
      extra: [`Total Selected: ${total}`, `Leave Success : ${done}`, `Leave Failed  : ${failed}`] });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "remove_members") {
    const pm = await startProgress(ctx, uid, `🧹 Removing members — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, totalRem = 0, cancelled = false;
    const boxLines = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `🧹 Removing members (1 by 1)...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { const n = await withRetry(() => removeAllMembers(uid, g.id, 1, true)); totalRem += n; done++; boxLines.push(`${g.name}: ${n} members removed`); }
      catch { failed++; boxLines.push(`❌ ${g.name}: failed`); }
      await sleep(D.removeMembers);
    }
    await sendSummary(ctx, { feature, total, success: done, failed, cancelled,
      extra: [`Total Selected: ${total}`, `Total Removed : ${totalRem}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "make_admin") {
    const pm = await startProgress(ctx, uid, `👑 Making admin — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, totalProm = 0, cancelled = false;
    const boxLines = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `👑 Making admin...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { const n = await makeAdminByNumbers(uid, g.id, extraNums); totalProm += n; done++; boxLines.push(n > 0 ? `${g.name}: ${n} admin set` : `${g.name}: not found`); }
      catch { failed++; boxLines.push(`❌ ${g.name}: failed`); }
      await sleep(D.makeAdmin);
    }
    await sendSummary(ctx, { feature, total, success: done, failed, cancelled,
      extra: [`Number(s)     : ${extraNums.map(n => `+${n}`).join(", ")}`, `Total Selected: ${total}`, `Admin Set     : ${totalProm}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "demote_admin") {
    const pm = await startProgress(ctx, uid, `⬇️ Demoting admins — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, totalDem = 0, cancelled = false;
    const boxLines = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `⬇️ Demoting admins...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { const n = await demoteAdminInGroup(uid, g.id, extraNums); totalDem += n; done++; boxLines.push(n > 0 ? `${g.name}: ${n} demoted` : `${g.name}: not an admin`); }
      catch { failed++; boxLines.push(`❌ ${g.name}: failed`); }
      await sleep(D.demoteAdmin);
    }
    await sendSummary(ctx, { feature, total, success: done, failed, cancelled,
      extra: [`Number(s)     : ${extraNums.map(n => `+${n}`).join(", ")}`, `Total Selected: ${total}`, `Total Demoted : ${totalDem}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "reset_link") {
    const pm = await startProgress(ctx, uid, `🔄 Resetting links — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, cancelled = false;
    const results = [], fails = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `🔄 Resetting links...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { results.push({ name: g.name, link: await withRetry(() => resetGroupInviteLink(uid, g.id)) }); done++; }
      catch { fails.push(g.name); failed++; }
      await sleep(D.resetLink);
    }
    const boxLines = results.map((r) => `${r.name}\n${r.link}`);
    fails.forEach((n) => boxLines.push(`❌ ${n}: failed`));
    await sendSummary(ctx, { feature: "reset_link", total, success: done, failed, cancelled,
      extra: [`Total Selected: ${total}`, `Success       : ${done}`, `Failed        : ${failed}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "approval") {
    const pm = await startProgress(ctx, uid, `🔀 Toggling approval — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, cancelled = false;
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `🔀 Toggling approval...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { const cur = await withRetry(() => getGroupApprovalStatus(uid, g.id)); await withRetry(() => setGroupApproval(uid, g.id, !cur)); done++; }
      catch { failed++; }
      await sleep(D.approvalToggle);
    }
    await sendSummary(ctx, { feature, total, success: done, failed, cancelled,
      extra: [`Total Selected: ${total}`, `Toggle Success : ${done}`, `Toggle Failed  : ${failed}`] });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "approve_pending") {
    const pm = await startProgress(ctx, uid, `✅ Approving pending — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, totPend = 0, totApproved = 0, cancelled = false;
    const boxLines = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `✅ Approving pending...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { const r = await withRetry(() => approveAllPending(uid, g.id), 2, 5000); totPend += r.pendingCount; totApproved += r.approved; done++; boxLines.push(`${i + 1}. ${g.name} ${r.approved} member add`); }
      catch { failed++; boxLines.push(`${i + 1}. ${g.name}: failed`); }
      await sleep(D.approvePending);
    }
    await sendSummary(ctx, { feature, total, success: done, failed, cancelled,
      extra: [`Total Groups  : ${total}`, `Total Pending : ${totPend}`, `Total Approved: ${totApproved}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "member_list") {
    const pm = await startProgress(ctx, uid, `📋 Counting members — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, grandTotal = 0, cancelled = false;
    const boxLines = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `📋 Member list...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { const members = await withRetry(() => getGroupMembers(uid, g.id)); grandTotal += members.length; boxLines.push(`${i + 1} = ${members.length} members`); done++; }
      catch { failed++; boxLines.push(`${g.name}\nfailed`); }
      await sleep(D.memberList);
    }
    await sendSummary(ctx, { feature: "member_list", total, success: done, failed, cancelled,
      extra: [`Total Groups  : ${total}`, `Total Members : ${grandTotal}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }

  if (feature === "pending_list") {
    const pm = await startProgress(ctx, uid, `⏳ Fetching pending — ${total} group(s)...\n${bar(0, total)}`);
    let done = 0, failed = 0, grandPending = 0, cancelled = false;
    const boxLines = [];
    for (let i = 0; i < total; i++) {
      if (isCancelled(uid)) { cancelled = true; break; }
      const g = sel[i];
      await editProgress(ctx.chat.id, pm.message_id, `⏳ Pending list...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${g.name}\n${bar(i, total)}`);
      try { const { list: pending } = await withRetry(() => getGroupPendingRequests(uid, g.id)); grandPending += pending.length; boxLines.push(`${i + 1} = ${pending.length} pending`); done++; }
      catch { failed++; boxLines.push(`${g.name}\nfailed`); }
      await sleep(D.pendingList);
    }
    await sendSummary(ctx, { feature: "pending_list", total, success: done, failed, cancelled,
      extra: [`Total Groups  : ${total}`, `Total Pending : ${grandPending}`], boxLines });
    updateSession(uid, { featureFlow: null }); return;
  }
}

// ─── Join Groups ────────────────────────────────────────────────────────────
bot.action("join_groups_start", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
  if (getStatus(uid) !== "connected") { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); return; }
  updateSession(uid, { joinFlow: { step: "links" }, cancelPending: false });
  await reply(ctx, `🔗 *Join Groups*\n━━━━━━━━━━━━━━━━━━━━\n\nSend invite links — one per line:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "back_menu")]]) });
});

// ─── Create Groups ───────────────────────────────────────────────────────────
bot.action("create_groups_start", async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!(await isPremium(uid))) { await ctx.answerCbQuery("💎 Premium required!", { show_alert: true }); return; }
  if (getStatus(uid) !== "connected") { await ctx.answerCbQuery("⚠️ Connect WhatsApp first!", { show_alert: true }); return; }
  updateSession(uid, { groupFlow: defaultGroupFlow() });
  await reply(ctx, `➕ *Create Groups — Step 1/9*\n━━━━━━━━━━━━━━━━━━━━\n\n*Group name?*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "back_menu")]]) });
});

async function askNumbering(ctx) {
  const flow = getSession(ctx.from.id).groupFlow;
  await reply(ctx, `➕ *Create Groups — Step 3/9*\n━━━━━━━━━━━━━━━━━━━━\n\n*Add numbering?*\n\nYes → _${flow.name} 1, ${flow.name} 2..._\nNo  → All named _${flow.name}_`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("✅ Yes","gf_num_yes"),Markup.button.callback("❌ No","gf_num_no")],[Markup.button.callback("❌ Cancel","back_menu")]]) });
}
bot.action("gf_num_yes",async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,numbering:true,step:"description"}});await askDescription(ctx);});
bot.action("gf_num_no", async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,numbering:false,step:"description"}});await askDescription(ctx);});

async function askDescription(ctx) {
  await reply(ctx,`➕ *Create Groups — Step 4/9*\n━━━━━━━━━━━━━━━━━━━━\n\n*Group description:*\n_Skip to leave empty._`,
    {parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip","gf_desc_skip")],[Markup.button.callback("❌ Cancel","back_menu")]])});
}
bot.action("gf_desc_skip",async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,description:"",step:"photo"}});await askPhoto(ctx);});

async function askPhoto(ctx) {
  await reply(ctx,`➕ *Create Groups — Step 5/9*\n━━━━━━━━━━━━━━━━━━━━\n\n*Group photo:*\n_Skip for default._`,
    {parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip","gf_photo_skip")],[Markup.button.callback("❌ Cancel","back_menu")]])});
}
bot.action("gf_photo_skip",async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,photo:null,step:"disappearing"}});await askDisappearing(ctx);});

async function askDisappearing(ctx) {
  await reply(ctx,`➕ *Create Groups — Step 6/9*\n━━━━━━━━━━━━━━━━━━━━\n\n*Disappearing messages:*`,
    {parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("24h","gf_dis_86400"),Markup.button.callback("7 Days","gf_dis_604800"),Markup.button.callback("90 Days","gf_dis_7776000")],[Markup.button.callback("⏭ Off","gf_dis_0")],[Markup.button.callback("❌ Cancel","back_menu")]])});
}
[0,86400,604800,7776000].forEach((s)=>{bot.action(`gf_dis_${s}`,async(ctx)=>{await ctx.answerCbQuery();const ss=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...ss.groupFlow,disappearing:s,step:"members"}});await askMembers(ctx);});});

async function askMembers(ctx) {
  await reply(ctx,`➕ *Create Groups — Step 7/9*\n━━━━━━━━━━━━━━━━━━━━\n\n*Add members? (one number per line)*`,
    {parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip","gf_mem_skip")],[Markup.button.callback("❌ Cancel","back_menu")]])});
}
bot.action("gf_mem_skip",async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,members:[],makeAdmin:false,step:"permissions"}});await askPermissions(ctx);});

async function askAdmin(ctx) {
  const flow=getSession(ctx.from.id).groupFlow;
  await reply(ctx,`➕ *Create Groups — Step 8/9*\n━━━━━━━━━━━━━━━━━━━━\n\n👥 *${flow.members.length} member(s)* added.\n\n*Make them admin?*`,
    {parse_mode:"Markdown",...Markup.inlineKeyboard([[Markup.button.callback("✅ Yes","gf_admin_yes"),Markup.button.callback("❌ No","gf_admin_no")],[Markup.button.callback("❌ Cancel","back_menu")]])});
}
bot.action("gf_admin_yes",async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,makeAdmin:true,step:"permissions"}});await askPermissions(ctx);});
bot.action("gf_admin_no", async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,makeAdmin:false,step:"permissions"}});await askPermissions(ctx);});

function permKb(p) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💬 All Can Send   : ${p.sendMessages?"✅ ON":"❌ OFF"}`,   "gf_pt_sendMessages")],
    [Markup.button.callback(`✏️ All Can Edit   : ${p.editInfo?"✅ ON":"❌ OFF"}`,       "gf_pt_editInfo")],
    [Markup.button.callback(`➕ All Can Add    : ${p.addMembers?"✅ ON":"❌ OFF"}`,     "gf_pt_addMembers")],
    [Markup.button.callback(`🔐 Join Approval : ${p.approveMembers?"✅ ON":"❌ OFF"}`, "gf_pt_approveMembers")],
    [Markup.button.callback("💾 Save & Continue","gf_perm_save")],
    [Markup.button.callback("❌ Cancel","back_menu")],
  ]);
}
async function askPermissions(ctx) {
  const p=getSession(ctx.from.id).groupFlow.permissions;
  await reply(ctx,`➕ *Create Groups — Step 9/9*\n━━━━━━━━━━━━━━━━━━━━\n\n*Set permissions:*`,
    {parse_mode:"Markdown",...permKb(p)});
}
["sendMessages","editInfo","addMembers","approveMembers"].forEach((key)=>{
  bot.action(`gf_pt_${key}`,async(ctx)=>{
    await ctx.answerCbQuery();
    const s=getSession(ctx.from.id),p={...s.groupFlow.permissions,[key]:!s.groupFlow.permissions[key]};
    updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,permissions:p}});
    try{await ctx.editMessageReplyMarkup(permKb(p).reply_markup);}catch{await askPermissions(ctx);}
  });
});
bot.action("gf_perm_save",async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,step:"confirm"}});await showConfirm(ctx);});

function fmtDis(s){return !s?"Off":s===86400?"24h":s===604800?"7 Days":s===7776000?"90 Days":`${s}s`;}
async function showConfirm(ctx) {
  const flow=getSession(ctx.from.id).groupFlow,p=flow.permissions;
  const prev=flow.numbering
    ?Array.from({length:Math.min(flow.count,3)},(_,i)=>`${flow.name} ${i+1}`).join(", ")+(flow.count>3?` ...(${flow.count})`:"")
    :`${flow.name} ×${flow.count}`;
  await reply(ctx,
    `✅ *Review — Create Groups*\n━━━━━━━━━━━━━━━━━━━━\n`+
    `Name       : *${flow.name}*\nCount      : ${flow.count} groups\nNumbering  : ${flow.numbering?"Yes":"No"}\n`+
    `Preview    : _${prev}_\nDesc       : ${flow.description||"(none)"}\nDisappear  : ${fmtDis(flow.disappearing)}\n`+
    `Members    : ${flow.members.length} | Make Admin: ${flow.makeAdmin?"Yes":"No"}\n`+
    `💬 All Send : ${p.sendMessages?"ON":"OFF"} | ✏️ Edit: ${p.editInfo?"ON":"OFF"}\n`+
    `➕ All Add  : ${p.addMembers?"ON":"OFF"} | 🔐 Approval: ${p.approveMembers?"ON":"OFF"}`,
    {parse_mode:"Markdown",...Markup.inlineKeyboard([
      [Markup.button.callback("🚀 Create Groups","gf_create")],
      [Markup.button.callback("✏️ Name","gf_edit_name"),Markup.button.callback("🔢 Count","gf_edit_count"),Markup.button.callback("📝 Desc","gf_edit_desc")],
      [Markup.button.callback("👥 Members","gf_edit_members"),Markup.button.callback("⚙️ Perms","gf_edit_perms")],
      [Markup.button.callback("❌ Cancel","back_menu")],
    ])});
}
["name","count","desc","members"].forEach((key)=>{
  bot.action(`gf_edit_${key}`,async(ctx)=>{
    await ctx.answerCbQuery();
    const map={name:"name_edit",count:"count_edit",desc:"description_edit",members:"members_edit"};
    updateSession(ctx.from.id,{groupFlow:{...getSession(ctx.from.id).groupFlow,step:map[key]}});
    const prompts={name_edit:"Send new name:",count_edit:"Send new count (1-50):",description_edit:"Send new description:",members_edit:"Send member numbers (one per line):"};
    await reply(ctx,prompts[map[key]],{...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel","back_menu")]])});
  });
});
bot.action("gf_edit_perms",async(ctx)=>{await ctx.answerCbQuery();updateSession(ctx.from.id,{groupFlow:{...getSession(ctx.from.id).groupFlow,step:"permissions"}});await askPermissions(ctx);});
[1,5,10,20,50].forEach((n)=>{bot.action(`gf_count_${n}`,async(ctx)=>{await ctx.answerCbQuery();const s=getSession(ctx.from.id);updateSession(ctx.from.id,{groupFlow:{...s.groupFlow,count:n,step:"numbering"}});await askNumbering(ctx);});});

bot.action("gf_create", async (ctx) => {
  await ctx.answerCbQuery("Creating...");
  const uid  = ctx.from.id, flow = getSession(uid).groupFlow;
  const total = flow.count;
  const pm = await startProgress(ctx, uid, `➕ Creating ${total} group(s)...\n${bar(0, total)}`);
  let done = 0, failed = 0, cancelled = false;
  const boxLines = [];
  for (let i = 0; i < total; i++) {
    if (isCancelled(uid)) { cancelled = true; break; }
    const name = flow.numbering ? `${flow.name} ${i + 1}` : flow.name;
    await editProgress(ctx.chat.id, pm.message_id, `➕ Creating groups...\nDone: ${done}/${total}  ❌ ${failed}\n→ ${name}\n${bar(i, total)}`);
    try {
      const initJids = flow.members.length > 0 ? flow.members.map(n => `${n}@s.whatsapp.net`) : [`${getPhone(uid)}@s.whatsapp.net`];
      const res = await withRetry(() => createGroup(uid, name, initJids), 3, 2000);
      const gid = res.id || res.gid;
      await sleep(4000);
      if (flow.description) { try { await updateGroupDescription(uid, gid, flow.description); } catch {} await sleep(1000); }
      if (flow.photo) {
        try {
          let buf = flow.photo;
          if (!Buffer.isBuffer(buf)) buf = Buffer.from(Object.values(buf));
          await sleep(1500);
          await updateGroupPhoto(uid, gid, buf);
        } catch {}
        await sleep(1000);
      }
      if (flow.disappearing) { try { await setDisappearingMessages(uid, gid, flow.disappearing); } catch {} await sleep(800); }
      if (flow.makeAdmin && flow.members.length) {
        try { await promoteToAdmin(uid, gid, flow.members.map(n => `${n}@s.whatsapp.net`)); } catch {} await sleep(800);
      }
      if (Object.values(flow.permissions).some(Boolean)) {
        try { await setGroupPermissions(uid, gid, flow.permissions); } catch {} await sleep(800);
      }
      let link = "";
      try { link = await withRetry(() => getGroupInviteLink(uid, gid), 3, 2000); } catch {}
      done++; boxLines.push(`${name}${link ? `\n${link}` : ""}`);
    } catch (err) { failed++; boxLines.push(`❌ ${name}: ${err.message}`); }
    await sleep(D.createGroup);
  }
  await sendSummary(ctx, { feature: "create_groups", total, success: done, failed, cancelled,
    extra: [`Total: ${total}`, `Created: ${done}`, `Failed: ${failed}`], boxLines });
  updateSession(uid, { groupFlow: null });
});

// ─── Add Members ────────────────────────────────────────────────────────────
bot.action("am_mode_onebyone", async (ctx) => { await ctx.answerCbQuery(); const f=getSession(ctx.from.id).featureFlow; updateSession(ctx.from.id,{featureFlow:{...f,addMode:"onebyone",step:"am_awaiting_vcf"}}); await askNextVcf(ctx); });
bot.action("am_mode_bulk",     async (ctx) => { await ctx.answerCbQuery(); const f=getSession(ctx.from.id).featureFlow; updateSession(ctx.from.id,{featureFlow:{...f,addMode:"bulk",    step:"am_awaiting_vcf"}}); await askNextVcf(ctx); });

async function askNextVcf(ctx) {
  const uid = ctx.from.id, flow = getSession(uid).featureFlow;
  const total = (flow.links||[]).length, idx = flow.currentVcfIdx || 0;
  if (idx >= total) { await runAddMembersFromVcfs(ctx); return; }
  const code = flow.links[idx];
  updateSession(uid, { awaitingVcf: { feature: "add_members", step: "am_vcf", linkIdx: idx } });
  await reply(ctx, `➕ *Add Members — VCF ${idx+1}/${total}*\n━━━━━━━━━━━━━━━━━━━━\n\nSend VCF for group ${idx + 1}:\n\`https://chat.whatsapp.com/${code}\``,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("⏭ Skip This Group","am_skip_vcf")],[Markup.button.callback("🏠 Main Menu","back_menu")]]) });
}
bot.action("am_skip_vcf",async(ctx)=>{
  await ctx.answerCbQuery("Skipped");
  const uid=ctx.from.id,flow=getSession(uid).featureFlow;
  const newVcfs=[...(flow.vcfs||[])];newVcfs[flow.currentVcfIdx||0]=null;
  updateSession(uid,{featureFlow:{...flow,currentVcfIdx:(flow.currentVcfIdx||0)+1,vcfs:newVcfs},awaitingVcf:null});
  await askNextVcf(ctx);
});
async function runAddMembersFromVcfs(ctx) {
  const uid = ctx.from.id, flow = getSession(uid).featureFlow;
  const links = flow.links||[], vcfs = flow.vcfs||[], total = links.length;
  updateSession(uid, { cancelPending: false, awaitingVcf: null });
  const pm = await startProgress(ctx, uid, `➕ Adding members — ${total} group(s)...\n${bar(0, total)}`);
  let doneGroups=0, failedGroups=0, totAdded=0, totFailed=0, totSkipped=0, cancelled=false;
  const boxLines = [];
  for (let i=0; i<total; i++) {
    if (isCancelled(uid)) { cancelled=true; break; }
    const vcfEntry = vcfs[i];
    if (!vcfEntry) { doneGroups++; boxLines.push(`Group ${i+1}: skipped (no VCF)`); continue; }
    const contacts = Array.isArray(vcfEntry) ? vcfEntry : (vcfEntry.contacts || []);
    await editProgress(ctx.chat.id, pm.message_id, `➕ Adding members...\nGroup: ${i+1}/${total}  Added: ${totAdded}\n→ Group ${i+1}\n${bar(i, total)}`);
    try {
      const info = await withTimeout(withRetry(() => getGroupInfoFromLink(uid, links[i]), 2, 1500), 12000, "GetGroupInfo");
      if (!info) throw new Error("Invalid link");
      const result = await addMembersToGroup(uid, info.id, contacts.map(c=>c.phone), flow.addMode==="onebyone");
      totAdded+=result.added; totFailed+=result.failed; totSkipped+=result.skipped; doneGroups++;
      boxLines.push(`${info.name}: ${result.added} members added`);
    } catch { failedGroups++; boxLines.push(`❌ Group ${i+1}: failed`); }
    await sleep(D.addMembers);
  }
  await sendSummary(ctx, { feature: "add_members", total, success: doneGroups, failed: failedGroups, cancelled,
    extra: [`Total Groups : ${total}`, `Total Added  : ${totAdded}`, `Total Failed : ${totFailed}`, `Total Skipped: ${totSkipped}`], boxLines });
  updateSession(uid, { featureFlow: null, awaitingVcf: null });
}

// ─── CTC Checker ───────────────────────────────────────────────────────────
async function runCtcChecker(ctx) {
  const uid = ctx.from.id, flow = getSession(uid).featureFlow;
  const links = flow.links || [], vcfList = flow.vcfList || [], total = links.length;
  updateSession(uid, { cancelPending: false });
  const pm = await startProgress(ctx, uid, `🔍 CTC Check — ${total} group(s)...\n${bar(0, total)}`);
  let done = 0, failed = 0, cancelled = false;
  const reportLines = [];
  for (let i = 0; i < total; i++) {
    if (isCancelled(uid)) { cancelled = true; break; }
    await editProgress(ctx.chat.id, pm.message_id, `🔍 Checking CTC...\nDone: ${done}/${total}  ❌ ${failed}\nGroup ${i+1}/${total}\n${bar(i, total)}`);
    try {
      const info = await withTimeout(withRetry(() => getGroupInfoFromLink(uid, links[i]), 2, 1500), 12000, "GetGroupInfo");
      if (!info) throw new Error("Invalid/expired link");
      const vcfEntry = vcfList[i] || { contacts: [] }, vcfPhones = (vcfEntry.contacts || []).map((c) => c.phone);
      const { jids: pendingJids, phones: pendingPhones, count: pendingCount } =
        await withTimeout(withRetry(() => getPendingRawJids(uid, info.id), 2, 1500), 12000, "GetPendingJids");
      const resolved = vcfPhones.length ? await withTimeout(resolveVcfPhones(uid, vcfPhones), 20000, "ResolveVcf") : [];
      const vcfPhoneSet = new Set(vcfPhones.map((p) => String(p).replace(/\D/g, "")));
      let verifiedCount = 0;
      for (const r of resolved) {
        if ((r.phoneJid && pendingJids.has(r.phoneJid)) || (r.lid && pendingJids.has(r.lid))) { verifiedCount++; continue; }
        if (pendingPhones.size > 0) {
          const ph = r.phone;
          if (pendingPhones.has(ph)) { verifiedCount++; continue; }
          for (const pp of pendingPhones) { if (numberMatches(pp, ph)) { verifiedCount++; break; } }
        }
      }
      if (verifiedCount === 0 && pendingPhones.size > 0 && vcfPhoneSet.size > 0) {
        for (const vph of vcfPhoneSet) {
          if (pendingPhones.has(vph)) { verifiedCount++; continue; }
          for (const pp of pendingPhones) { if (numberMatches(pp, vph)) { verifiedCount++; break; } }
        }
      }
      const wrongCount = Math.max(0, pendingCount - verifiedCount);
      done++; reportLines.push(`${info.name}: valid ${verifiedCount} member, ${wrongCount} wrong contact number`);
    } catch (err) { failed++; reportLines.push(`❌ Group ${i+1}: ${err.message}`); }
    await sleep(D.ctcCheck);
  }
  await sendSummary(ctx, { feature: "ctc_checker", total, success: done, failed, cancelled,
    extra: [`Total Groups : ${total}`, `Checked      : ${done}`, `Failed       : ${failed}`], boxLines: reportLines });
  updateSession(uid, { featureFlow: null, awaitingVcf: null });
}

// ══════════════════════════════════════════════════════════════════════════
// ─── TEXT HANDLER ─────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════

bot.on("text", async (ctx) => {
  const uid = ctx.from.id, s = getSession(uid), text = ctx.message.text.trim();
  if (text.startsWith("/")) return;

  // ── Admin flow ────────────────────────────────────────────────────────
  const adminFlow = s.adminFlow;
  if (adminFlow) {
    // Redeem key
    if (adminFlow.action === "redeem" && adminFlow.step === "wait_key") {
      updateSession(uid, { adminFlow: null });
      await processRedeemKey(ctx, uid, text);
      return;
    }
    // Admin actions (give/remove premium, ban, unban, etc.)
    if (await isAdminOrOwner(uid)) {
      if (adminFlow.step === "wait_uid") {
        const targetUid = parseInt(text.trim(), 10);
        if (isNaN(targetUid)) { await ctx.reply("❌ Invalid user ID. Send a numeric ID:"); return; }
        const action = adminFlow.action;
        // Actions that need a second step
        if (action === "temp_premium") {
          updateSession(uid, { adminFlow: { ...adminFlow, step: "wait_duration", data: { targetUid } } });
          await ctx.reply(`⏰ User \`${targetUid}\` selected.\n\nSend duration in seconds (e.g. \`86400\` for 1 day, \`3600\` for 1 hour):`,
            { parse_mode: "Markdown", ...Markup.inlineKeyboard([
              [Markup.button.callback("1h", "tprem:3600"), Markup.button.callback("1d", "tprem:86400"), Markup.button.callback("7d", "tprem:604800"), Markup.button.callback("30d", "tprem:2592000")],
              [Markup.button.callback("❌ Cancel", "admin_panel")],
            ]) }
          );
          return;
        }
        if (action === "send_to_user") {
          updateSession(uid, { adminFlow: { ...adminFlow, step: "wait_msg", data: { targetUid } } });
          await ctx.reply(`📩 Target: \`${targetUid}\`\n\nNow send the message:`, { parse_mode: "Markdown" });
          return;
        }
        // Single-step admin actions
        updateSession(uid, { adminFlow: null });
        try {
          if (action === "give_premium") {
            await UserInfo.findOneAndUpdate({ userId: targetUid }, { $set: { isPremium: true, premiumExpiry: null } }, { upsert: true });
            await ctx.reply(`✅ Premium given to \`${targetUid}\`.`, { parse_mode: "Markdown" });
            try { await bot.telegram.sendMessage(targetUid, "🎉 You've been granted *Premium* by admin!", { parse_mode: "Markdown" }); } catch {}
          } else if (action === "remove_premium") {
            await UserInfo.updateOne({ userId: targetUid }, { $set: { isPremium: false, premiumExpiry: null } });
            await ctx.reply(`✅ Premium removed from \`${targetUid}\`.`, { parse_mode: "Markdown" });
          } else if (action === "ban") {
            if (isOwner(targetUid)) { await ctx.reply("⚠️ Cannot ban the owner!"); return; }
            await UserInfo.findOneAndUpdate({ userId: targetUid }, { $set: { isBanned: true } }, { upsert: true });
            await disconnectAccount(targetUid).catch(() => {});
            await ctx.reply(`✅ User \`${targetUid}\` banned.`, { parse_mode: "Markdown" });
            try { await bot.telegram.sendMessage(targetUid, "🚫 You have been banned from this bot."); } catch {}
          } else if (action === "unban") {
            await UserInfo.updateOne({ userId: targetUid }, { $set: { isBanned: false } });
            await ctx.reply(`✅ User \`${targetUid}\` unbanned.`, { parse_mode: "Markdown" });
            try { await bot.telegram.sendMessage(targetUid, "✅ You have been unbanned! Use /start to continue."); } catch {}
          } else if (action === "add_admin") {
            if (!isOwner(uid)) { await ctx.reply("❌ Owner only."); return; }
            if (isOwner(targetUid)) { await ctx.reply("⚠️ Owner is already above admin."); return; }
            await UserInfo.findOneAndUpdate({ userId: targetUid }, { $set: { isAdmin: true } }, { upsert: true });
            await ctx.reply(`✅ User \`${targetUid}\` made admin.`, { parse_mode: "Markdown" });
            try { await bot.telegram.sendMessage(targetUid, "🛡 You've been made an *Admin*!", { parse_mode: "Markdown" }); } catch {}
          } else if (action === "remove_admin") {
            if (!isOwner(uid)) { await ctx.reply("❌ Owner only."); return; }
            await UserInfo.updateOne({ userId: targetUid }, { $set: { isAdmin: false } });
            await ctx.reply(`✅ Admin removed from \`${targetUid}\`.`, { parse_mode: "Markdown" });
            try { await bot.telegram.sendMessage(targetUid, "⚠️ Your admin access has been removed."); } catch {}
          }
        } catch (err) { await ctx.reply(`❌ Error: ${err.message}`); }
        return;
      }
      if (adminFlow.step === "wait_duration" && adminFlow.action === "temp_premium") {
        const secs = parseInt(text.trim(), 10);
        if (isNaN(secs) || secs < 1) { await ctx.reply("❌ Invalid seconds. Example: `86400`", { parse_mode: "Markdown" }); return; }
        const targetUid = adminFlow.data.targetUid, expiry = new Date(Date.now() + secs * 1000);
        await UserInfo.findOneAndUpdate({ userId: targetUid }, { $set: { isPremium: true, premiumExpiry: expiry } }, { upsert: true });
        updateSession(uid, { adminFlow: null });
        await ctx.reply(`✅ Temp premium granted to \`${targetUid}\` — expires ${expiry.toUTCString()}.`, { parse_mode: "Markdown" });
        try { await bot.telegram.sendMessage(targetUid, `🎉 You received *Temp Premium*!\n⏰ Expires: ${expiry.toUTCString()}`, { parse_mode: "Markdown" }); } catch {}
        return;
      }
      if (adminFlow.step === "wait_msg") {
        if (adminFlow.action === "broadcast") {
          updateSession(uid, { adminFlow: null });
          const allUsers = await UserInfo.find({});
          let sent = 0, failed = 0;
          for (const u of allUsers) {
            try { await bot.telegram.sendMessage(u.userId, text); sent++; }
            catch { failed++; }
            await sleep(100);
          }
          await ctx.reply(`📢 Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
          return;
        }
        if (adminFlow.action === "send_to_user") {
          const targetUid = adminFlow.data.targetUid;
          updateSession(uid, { adminFlow: null });
          try { await bot.telegram.sendMessage(targetUid, text); await ctx.reply(`✅ Sent to \`${targetUid}\`.`, { parse_mode: "Markdown" }); }
          catch { await ctx.reply(`❌ Failed to send.`); }
          return;
        }
      }
      if (adminFlow.step === "wait_msg" && adminFlow.action === "broadcast") {
        updateSession(uid, { adminFlow: null });
        const allUsers = await UserInfo.find({});
        let sent = 0, failed = 0;
        for (const u of allUsers) {
          try { await bot.telegram.sendMessage(u.userId, text); sent++; }
          catch { failed++; }
          await sleep(100);
        }
        await ctx.reply(`📢 Broadcast done!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
        return;
      }
    }
  }

  // ── WA phone input ────────────────────────────────────────────────────
  if (s.awaitingPhoneForIndex !== null && s.awaitingPhoneForIndex !== undefined) {
    const phone = text.replace(/[^0-9]/g, "");
    if (phone.length < 10) { await ctx.reply(`❌ Invalid number. Example: \`919876543210\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu","back_menu")]]) }); return; }
    updateSession(uid, { awaitingPhoneForIndex: null });
    const wm = await ctx.reply(`⏳ *Generating pairing code...*`, { parse_mode: "Markdown" });
    pendingPairingCbs.set(String(uid), async (code) => {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, wm.message_id); } catch {}
      if (!code) { await ctx.reply(`❌ *Failed to generate code. Try again.*`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Try Again","menu_account")],[Markup.button.callback("🏠 Main Menu","back_menu")]]) }); return; }
      await ctx.reply(
        `🔑 *Pairing Code*\n━━━━━━━━━━━━━━━━━━━━\n\n\`${code}\`\n\n━━━━━━━━━━━━━━━━━━━━\n*How to link:*\n1. Open WhatsApp\n2. Settings → Linked Devices → Link a Device\n3. Tap "Link with phone number"\n4. Enter the code above\n\n⚠️ Expires in *60 seconds*!\n⏳ Waiting for connection...`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔄 New Code","reset_wa")],[Markup.button.callback("🏠 Main Menu","back_menu")]]) }
      );
    });
    pendingReadyCbs.set(String(uid), async () => { await sendMainMenu(ctx); });
    connectAccount(uid, phone).catch(async (err) => {
      pendingPairingCbs.delete(String(uid)); pendingReadyCbs.delete(String(uid));
      await ctx.reply(`❌ Error: \`${err.message}\``, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu","back_menu")]]) });
    });
    return;
  }

  // ── Join Groups ────────────────────────────────────────────────────────
  if (s.joinFlow?.step === "links") {
    const codes = extractCodes(text);
    if (!codes.length) { await ctx.reply(`❌ No valid links found.`, { ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Try Again","join_groups_start")],[Markup.button.callback("🏠 Main Menu","back_menu")]]) }); return; }
    updateSession(uid, { joinFlow: null });
    const pm = await startProgress(ctx, uid, `🔗 Joining ${codes.length} group(s)...\n${bar(0, codes.length)}`);
    let joined=0, failed=0, cancelled=false;
    for (let i=0; i<codes.length; i++) {
      if (isCancelled(uid)) { cancelled=true; break; }
      await editProgress(ctx.chat.id, pm.message_id, `🔗 Joining groups...\n✅ ${joined}  ❌ ${failed}\nGroup ${i+1}/${codes.length}\n${bar(i, codes.length)}`);
      try { await withRetry(() => joinGroupViaLink(uid, codes[i])); joined++; }
      catch { failed++; }
      await sleep(D.joinGroup);
    }
    await sendSummary(ctx, { feature: "join_groups", total: codes.length, success: joined, failed, cancelled,
      extra: [`Total Links  : ${codes.length}`, `Joined       : ${joined}`, `Failed       : ${failed}`] });
    return;
  }

  // ── Similar keyword ────────────────────────────────────────────────────
  if (s.featureFlow?.step === "similar_query") {
    const kw = text.toLowerCase();
    try {
      const allGroups = s.featureFlow.allGroups?.length ? s.featureFlow.allGroups : await getAllGroupsWithDetails(uid);
      const filtered  = allGroups.filter((g) => g.name.toLowerCase().includes(kw));
      if (!filtered.length) { await ctx.reply(`❌ No groups match *"${text}"*.`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Try Again","gs_sim_custom")],[Markup.button.callback("🏠 Main Menu","back_menu")]]) }); return; }
      updateSession(uid, { featureFlow: { ...s.featureFlow, allGroups, selectedIds: filtered.map(g=>g.id), keyword: kw, step: "confirm" } });
      await ctx.reply(
        `✅ *${filtered.length} group(s) matched:*\n━━━━━━━━━━━━━━━━━━━━\n${filtered.slice(0,15).map((g,i)=>`${i+1}. ${g.name}`).join("\n")}${filtered.length>15?`\n_...and ${filtered.length-15} more_`:""}`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🚀 Proceed","gs_sim_proceed")],[Markup.button.callback("🏠 Main Menu","back_menu")]]) }
      );
    } catch (err) { await ctx.reply(`❌ Error: ${err.message}`); }
    return;
  }

  // ── Make Admin numbers ────────────────────────────────────────────────
  if (s.featureFlow?.step === "admin_numbers") {
    const nums = text.split(/[\n,\s]+/).map(n=>n.replace(/[^0-9]/g,"")).filter(n=>n.length>=7);
    if (!nums.length) { await ctx.reply("⚠️ No valid numbers found. Include country code."); return; }
    const flow = s.featureFlow;
    updateSession(uid, { featureFlow: { ...flow, adminNumbers: nums, step: "executing" } });
    await runFeature(ctx, flow.feature, flow.selectedIds, flow.allGroups, nums);
    return;
  }

  // ── Demote Admin numbers ──────────────────────────────────────────────
  if (s.featureFlow?.step === "demote_numbers") {
    const nums = text.split(/[\n,\s]+/).map(n=>n.replace(/[^0-9]/g,"")).filter(n=>n.length>=7);
    if (!nums.length) { await ctx.reply("⚠️ No valid numbers found."); return; }
    const flow = s.featureFlow;
    updateSession(uid, { featureFlow: { ...flow, adminNumbers: nums, step: "executing" } });
    await runFeature(ctx, "demote_admin", flow.selectedIds, flow.allGroups, nums);
    return;
  }

  // ── Auto Accept custom duration ───────────────────────────────────────
  if (s.featureFlow?.step === "aa_custom_duration") {
    const mins = parseInt(text, 10);
    if (isNaN(mins) || mins < 1) { await ctx.reply("⚠️ Enter valid minutes. Example: `120`", { parse_mode: "Markdown" }); return; }
    const flow = s.featureFlow, secs = mins * 60, label = mins >= 60 ? `${mins/60}h` : `${mins}min`;
    updateSession(uid, { featureFlow: { ...flow, aaDuration: secs, step: "aa_confirm" } });
    await ctx.reply(
      `⏰ *Auto Accept — Confirm*\n━━━━━━━━━━━━━━━━━━━━\nGroups: *${flow.selectedIds.length}*  Duration: *${label}*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("▶️ Start","aa_start")],[Markup.button.callback("🔙 Change","aa_back_duration")],[Markup.button.callback("🏠 Main Menu","back_menu")]]) }
    );
    return;
  }

  // ── Add Members links ─────────────────────────────────────────────────
  if (s.featureFlow?.step === "am_links") {
    const codes = extractCodes(text);
    if (!codes.length) { await ctx.reply("❌ No valid links found."); return; }
    updateSession(uid, { featureFlow: { ...s.featureFlow, links: codes, currentVcfIdx: 0, vcfs: [], step: "am_mode" } });
    await ctx.reply(`➕ *Add Members — ${codes.length} group(s) found*\n━━━━━━━━━━━━━━━━━━━━\n\n*How to add?*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🐢 One by One (Safe)","am_mode_onebyone")],
        [Markup.button.callback("⚡ Bulk (Fast)",       "am_mode_bulk")],
        [Markup.button.callback("🏠 Main Menu","back_menu")],
      ]) }
    );
    return;
  }

  // ── Change Name custom: base name ─────────────────────────────────────
  if (s.featureFlow?.step === "cn_random_name") {
    const name = text.slice(0, 100);
    updateSession(uid, { featureFlow: { ...s.featureFlow, cnBaseName: name, step: "cn_random_numbering" } });
    await ctx.reply(
      `✏️ *Change Name*\n━━━━━━━━━━━━━━━━━━━━\nBase name: *${name}*\n\n*Add numbering?*\nYes → _${name} 1, ${name} 2..._`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Yes — add numbers","cn_numbering_yes"),Markup.button.callback("❌ No","cn_numbering_no")],
        [Markup.button.callback("🏠 Main Menu","back_menu")],
      ]) }
    );
    return;
  }

  // ── Change Name custom: links ─────────────────────────────────────────
  if (s.featureFlow?.step === "cn_random_links") {
    const codes = extractCodes(text);
    if (!codes.length) { await ctx.reply("❌ No valid links found."); return; }
    await runChangeNameRandom(ctx, codes, s.featureFlow.cnBaseName, s.featureFlow.numbering !== false);
    return;
  }

  // ── CTC Checker links ─────────────────────────────────────────────────
  if (s.featureFlow?.step === "ctc_links") {
    const codes = extractCodes(text);
    if (!codes.length) { await ctx.reply("❌ No valid links found."); return; }
    updateSession(uid, {
      featureFlow: { ...s.featureFlow, links: codes, vcfList: [], ctcVcfIdx: 0, step: "ctc_vcf_collecting" },
      awaitingVcf: { feature: "ctc_checker", step: "ctc_vcf_collecting" },
    });
    await ctx.reply(
      `🔍 *CTC Checker — ${codes.length} group(s)*\n━━━━━━━━━━━━━━━━━━━━\n*Step 2:* Upload VCF files.\n\n📎 *Send all ${codes.length} VCF files now, then press Start Check:*`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback(`▶️ Start Check (0 VCFs uploaded)`, "ctc_start_check")],
        [Markup.button.callback("🏠 Main Menu","back_menu")],
      ]) }
    );
    return;
  }

  // ── Create Groups steps ───────────────────────────────────────────────
  const flow = s.groupFlow;
  if (!flow) { await sendMainMenu(ctx); return; }
  if (flow.step==="name")          { const name=text.slice(0,100); updateSession(uid,{groupFlow:{...flow,name,step:"count"}});await ctx.reply(`➕ *Create Groups — Step 2/9*\n━━━━━━━━━━━━━━━━━━━━\nName: *${name}*\n\n*How many groups? (1–50)*`,{parse_mode:"Markdown",...Markup.inlineKeyboard([[1,5,10,20,50].map(n=>Markup.button.callback(`${n}`,`gf_count_${n}`)),[Markup.button.callback("❌ Cancel","back_menu")]])}); return; }
  if (flow.step==="name_edit")     { updateSession(uid,{groupFlow:{...flow,name:text.slice(0,100),step:"confirm"}});await showConfirm(ctx); return; }
  if (flow.step==="count"||flow.step==="count_edit") {
    const n=parseInt(text,10);
    if(isNaN(n)||n<1||n>50){await ctx.reply("⚠️ Enter a number between 1 and 50.");return;}
    if(flow.step==="count_edit"){updateSession(uid,{groupFlow:{...flow,count:n,step:"confirm"}});await showConfirm(ctx);}
    else{updateSession(uid,{groupFlow:{...flow,count:n,step:"numbering"}});await askNumbering(ctx);}
    return;
  }
  if (flow.step==="description")      { updateSession(uid,{groupFlow:{...flow,description:text.slice(0,512),step:"photo"}});await askPhoto(ctx); return; }
  if (flow.step==="description_edit") { updateSession(uid,{groupFlow:{...flow,description:text.slice(0,512),step:"confirm"}});await showConfirm(ctx); return; }
  if (flow.step==="members"||flow.step==="members_edit") {
    const nums=text.split(/[\n,\s]+/).map(n=>n.replace(/[^0-9]/g,"")).filter(n=>n.length>=10);
    if(!nums.length){await ctx.reply("⚠️ No valid numbers found.");return;}
    if(flow.step==="members_edit"){updateSession(uid,{groupFlow:{...flow,members:nums,step:"confirm"}});await showConfirm(ctx);}
    else{updateSession(uid,{groupFlow:{...flow,members:nums,step:"admin"}});await askAdmin(ctx);}
    return;
  }
  await sendMainMenu(ctx);
});

// ─── Temp Premium inline buttons ────────────────────────────────────────────
bot.action(/^tprem:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!(await isAdminOrOwner(ctx.from.id))) return;
  const secs = parseInt(ctx.match[1]), flow = getSession(ctx.from.id).adminFlow;
  if (!flow?.data?.targetUid) return;
  const targetUid = flow.data.targetUid, expiry = new Date(Date.now() + secs * 1000);
  await UserInfo.findOneAndUpdate({ userId: targetUid }, { $set: { isPremium: true, premiumExpiry: expiry } }, { upsert: true });
  updateSession(ctx.from.id, { adminFlow: null });
  await editOrReply(ctx, `✅ Temp premium granted to \`${targetUid}\` — expires ${expiry.toUTCString()}.`,
    { parse_mode: "Markdown", reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🔙 Admin Panel", "admin_panel")]]).reply_markup });
  try { await bot.telegram.sendMessage(targetUid, `🎉 You received *Temp Premium*!\n⏰ Expires: ${expiry.toUTCString()}`, { parse_mode: "Markdown" }); } catch {}
});

// ─── Document Handler (VCF) ────────────────────────────────────────────────
bot.on("document", async (ctx) => {
  const uid = ctx.from.id, s = getSession(uid), doc = ctx.message.document;
  const isVcf = doc.mime_type==="text/vcard"||doc.mime_type==="text/x-vcard"||doc.file_name?.toLowerCase().endsWith(".vcf");
  const awaitingVcf = s.awaitingVcf;

  if (awaitingVcf?.feature === "change_name" && s.featureFlow?.step === "cn_vcf_collecting") {
    if (!isVcf) { await ctx.reply("⚠️ Please send a .vcf file."); return; }
    try {
      const vcfName  = (doc.file_name || "").replace(/\.vcf$/i, "").trim() || "Unnamed";
      const contacts = parseVcf((await downloadFile(ctx, doc.file_id)).toString("utf8"));
      if (!contacts.length) { await ctx.reply("⚠️ No valid numbers in VCF."); return; }
      const flow = s.featureFlow, newVcfList = [...(flow.vcfList || []), { name: vcfName, contacts }];
      updateSession(uid, { featureFlow: { ...flow, vcfList: newVcfList } });
      await showVcfCollectStatus(ctx, newVcfList);
    } catch (err) { await ctx.reply(`❌ VCF read error: ${err.message}`); }
    return;
  }

  if (awaitingVcf?.feature === "add_members" && s.featureFlow?.step === "am_awaiting_vcf") {
    if (!isVcf) { await ctx.reply("⚠️ Please send a .vcf file."); return; }
    try {
      const contacts = parseVcf((await downloadFile(ctx, doc.file_id)).toString("utf8"));
      if (!contacts.length) { await ctx.reply("⚠️ No valid numbers in VCF."); return; }
      const flow = s.featureFlow, idx = flow.currentVcfIdx || 0, newVcfs = [...(flow.vcfs || [])];
      newVcfs[idx] = contacts;
      updateSession(uid, { featureFlow: { ...flow, vcfs: newVcfs, currentVcfIdx: idx + 1 }, awaitingVcf: null });
      await ctx.reply(`✅ *VCF received!* ${contacts.length} numbers found.`, { parse_mode: "Markdown" });
      if (idx + 1 >= (flow.links||[]).length) { await runAddMembersFromVcfs(ctx); }
      else { await askNextVcf(ctx); }
    } catch (err) { await ctx.reply(`❌ VCF read error: ${err.message}`); }
    return;
  }

  if (awaitingVcf?.feature === "ctc_checker" && s.featureFlow?.step === "ctc_vcf_collecting") {
    if (!isVcf) { await ctx.reply("⚠️ Please send a .vcf file."); return; }
    try {
      const contacts = parseVcf((await downloadFile(ctx, doc.file_id)).toString("utf8"));
      if (!contacts.length) { await ctx.reply("⚠️ No valid numbers in VCF."); return; }
      const flow = s.featureFlow, groupTotal = (flow.links || []).length, newList = [...(flow.vcfList || []), { contacts }], received = newList.length;
      updateSession(uid, { featureFlow: { ...flow, vcfList: newList, ctcVcfIdx: received } });
      await ctx.reply(
        `✅ *VCF ${received} received!* (${contacts.length} numbers)\n📊 VCFs so far: *${received}/${groupTotal}*\n\n📎 Send more or press *Start Check*:`,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard([
          [Markup.button.callback(`▶️ Start Check (${received} VCF${received > 1 ? "s" : ""} uploaded)`, "ctc_start_check")],
          [Markup.button.callback("🏠 Main Menu","back_menu")],
        ]) }
      );
    } catch (err) { await ctx.reply(`❌ VCF read error: ${err.message}`); }
    return;
  }
});

// ─── Photo Handler ─────────────────────────────────────────────────────────
bot.on("photo", async (ctx) => {
  const uid = ctx.from.id, flow = getSession(uid).groupFlow;
  if (!flow || (flow.step !== "photo" && flow.step !== "photo_edit")) return;
  try {
    const p  = ctx.message.photo[ctx.message.photo.length - 1];
    const u  = await ctx.telegram.getFileLink(p.file_id);
    const r  = await fetch(u.href);
    const buf = Buffer.from(await r.arrayBuffer());
    const ns  = flow.step === "photo_edit" ? "confirm" : "disappearing";
    updateSession(uid, { groupFlow: { ...flow, photo: buf, step: ns } });
    await ctx.reply("✅ *Photo saved!*", { parse_mode: "Markdown" });
    if (ns === "confirm") await showConfirm(ctx); else await askDisappearing(ctx);
  } catch { await ctx.reply("❌ Could not save photo. Please try again."); }
});

bot.catch((err) => console.error("[Bot Error]", err.message));

// ─── Health server ─────────────────────────────────────────────────────────
const app = express(), PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff"><h2>✅ WA Group Manager Bot</h2><p style="color:#4ade80">Running 🟢</p><p>WA Connected: ${getConnectedCount()}</p></body></html>`));
app.get("/health", (_, res) => res.json({ status: "ok", waConnected: getConnectedCount(), uptime: fmtUptime(Date.now() - BOT_START), ts: new Date().toISOString() }));
app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));

function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL; if (!url) return;
  const full = url.startsWith("http") ? url : `https://${url}`;
  (full.startsWith("https") ? https : http).get(`${full}/health`, r => console.log(`[Ping] ${r.statusCode}`)).on("error", e => console.error("[Ping]", e.message));
}
setTimeout(() => { selfPing(); setInterval(selfPing, 120000); }, 60000);

async function main() {
  await connectDB();
  await reconnectSavedAccounts();
  await bot.launch({ dropPendingUpdates: true });
  console.log(`WA Group Manager Bot running — Owner: ${OWNER_ID || "NOT SET"}`);
}
main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
process.once("SIGINT",  () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
