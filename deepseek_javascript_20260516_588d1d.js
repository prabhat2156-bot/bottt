/**
 * WhatsApp Automation Bot - Fixed for Render
 * Uses webhook mode instead of polling
 */

const { Telegraf, Markup } = require("telegraf");
const { connectDB } = require("./src/db");
const express = require("express");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set!"); process.exit(1); }
const OWNER_ID = parseInt(process.env.OWNER_ID || "0", 10);
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(id => parseInt(id, 10)).filter(id => !isNaN(id));
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;

const bot = new Telegraf(TOKEN);
const app = express();

// ============ MODELS ============
const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema({
  userId: { type: Number, required: true, unique: true },
  username: { type: String, default: "" },
  firstName: { type: String, default: "" },
  lastName: { type: String, default: "" },
  isPremium: { type: Boolean, default: false },
  premiumExpiry: { type: Date, default: null },
  isBanned: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
  lastActive: { type: Date, default: Date.now },
  totalCommands: { type: Number, default: 0 },
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: Number, default: null },
  referralCount: { type: Number, default: 0 },
  whatsappConnected: { type: Boolean, default: false },
  whatsappPhone: { type: String, default: "" }
});

const User = mongoose.models.User || mongoose.model("User", UserSchema);

// ============ HELPER FUNCTIONS ============
async function createOrUpdateUser(userId, username, firstName, lastName) {
  let user = await User.findOne({ userId });
  if (!user) {
    const crypto = require("crypto");
    const referralCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    user = new User({ userId, username, firstName, lastName, referralCode });
    await user.save();
  } else {
    user.username = username || user.username;
    user.firstName = firstName || user.firstName;
    user.lastName = lastName || user.lastName;
    user.lastActive = new Date();
    await user.save();
  }
  return user;
}

async function getUserById(userId) {
  return await User.findOne({ userId });
}

async function getUserProfile(userId) {
  const user = await getUserById(userId);
  if (!user) return null;
  const premiumActive = user.isPremium && (!user.premiumExpiry || user.premiumExpiry > new Date());
  return {
    userId: user.userId,
    name: user.firstName || user.username || "Unknown",
    username: user.username,
    isPremium: premiumActive,
    premiumExpiry: user.premiumExpiry?.toLocaleString() || "Never",
    referralCode: user.referralCode,
    referralCount: user.referralCount,
    totalCommands: user.totalCommands,
    whatsappConnected: user.whatsappConnected,
    whatsappPhone: user.whatsappPhone
  };
}

async function grantPremium(userId, durationStr) {
  let durationMs = 0;
  if (durationStr === "forever") {
    durationMs = 1000 * 365 * 24 * 60 * 60 * 1000;
  } else {
    const match = durationStr.match(/^(\d+)([dhmy])$/);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2];
      if (unit === 'd') durationMs = num * 24 * 60 * 60 * 1000;
      else if (unit === 'h') durationMs = num * 60 * 60 * 1000;
      else if (unit === 'm') durationMs = num * 60 * 1000;
      else if (unit === 'y') durationMs = num * 365 * 24 * 60 * 60 * 1000;
    }
  }
  const expiry = new Date(Date.now() + durationMs);
  return await User.findOneAndUpdate(
    { userId },
    { isPremium: true, premiumExpiry: expiry },
    { upsert: true, new: true }
  );
}

// ============ BOT MIDDLEWARE ============
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();
  
  await createOrUpdateUser(userId, ctx.from.username, ctx.from.first_name, ctx.from.last_name);
  
  const user = await getUserById(userId);
  if (user?.isBanned) {
    await ctx.reply("⛔ You are banned from using this bot.");
    return;
  }
  
  return next();
});

// ============ MAIN MENU ============
function getMainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📱 Connect WhatsApp", "connect_wa")],
    [Markup.button.callback("➕ Create Group", "create_group"), Markup.button.callback("🔗 Join Group", "join_group")],
    [Markup.button.callback("🔗 Get Link", "get_link"), Markup.button.callback("🚪 Leave Group", "leave_group")],
    [Markup.button.callback("👑 Make Admin", "make_admin"), Markup.button.callback("⬇️ Demote Admin", "demote_admin")],
    [Markup.button.callback("✅ Approve Pending", "approve_pending"), Markup.button.callback("🔀 Approval Mode", "approval_mode")],
    [Markup.button.callback("📋 Member List", "member_list"), Markup.button.callback("👥 Pending List", "pending_list")],
    [Markup.button.callback("✏️ Rename Group", "rename_group"), Markup.button.callback("🔄 Reset Link", "reset_link")],
    [Markup.button.callback("📊 My Status", "my_status"), Markup.button.callback("🎁 Referral", "referral_menu")],
  ]);
}

async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  const profile = await getUserProfile(userId);
  
  const statusText = profile?.whatsappConnected ? `✅ +${profile.whatsappPhone}` : "❌ Not Connected";
  const premiumText = profile?.isPremium ? "⭐ Premium" : "🆓 Free";
  
  const menuText = `🤖 *WhatsApp Bot*\n━━━━━━━━━━━━━━━━━━━━\n👤 ${profile?.name || "User"}\n${premiumText}\n📱 WA: ${statusText}\n━━━━━━━━━━━━━━━━━━━━\n*Choose an option:*`;
  
  await ctx.reply(menuText, { parse_mode: "Markdown", ...getMainMenu() });
}

// ============ MY STATUS ============
async function sendMyStatus(ctx) {
  const userId = ctx.from.id;
  const profile = await getUserProfile(userId);
  
  if (!profile) return await sendMainMenu(ctx);
  
  const statusText = `📊 *My Status*\n━━━━━━━━━━━━━━━━━━━━\n👤 Name: ${profile.name}\n🆔 ID: \`${profile.userId}\`\n@${profile.username || "No username"}\n━━━━━━━━━━━━━━━━━━━━\n⭐ Premium: ${profile.isPremium ? "✅ Active" : "❌ Inactive"}\n📅 Expires: ${profile.premiumExpiry}\n━━━━━━━━━━━━━━━━━━━━\n📱 WhatsApp: ${profile.whatsappConnected ? "✅ Connected" : "❌ Not Connected"}\n📞 Phone: ${profile.whatsappPhone || "Not set"}\n━━━━━━━━━━━━━━━━━━━━\n🎁 Referral Code: \`${profile.referralCode}\`\n👥 Referrals: ${profile.referralCount}\n💬 Commands: ${profile.totalCommands}\n━━━━━━━━━━━━━━━━━━━━`;
  
  await ctx.reply(statusText, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]]) });
}

// ============ REFERRAL MENU ============
async function sendReferralMenu(ctx) {
  const userId = ctx.from.id;
  const user = await getUserById(userId);
  const botUsername = ctx.botInfo.username;
  const link = `https://t.me/${botUsername}?start=ref_${user?.referralCode}`;
  
  await ctx.reply(
    `🎁 *Referral Program*\n━━━━━━━━━━━━━━━━━━━━\n\nYour Code: \`${user?.referralCode}\`\n\nInvite Link:\n${link}\n\nReferred: ${user?.referralCount || 0} users\n\n*Reward:* 1 day premium per referral!\n\nShare your link and get premium!`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]]) }
  );
}

// ============ WHATSAPP CONNECTION (Mock for now) ============
async function connectWhatsApp(ctx) {
  const userId = ctx.from.id;
  
  await ctx.reply(
    `📱 *Connect WhatsApp*\n━━━━━━━━━━━━━━━━━━━━\n\n⚠️ *Note:* WhatsApp connection requires additional setup.\n\nFor now, you can use this bot for:\n• User management\n• Referral system\n• Premium features\n\nWhatsApp features will be available soon!`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]]) }
  );
}

// ============ FEATURE PLACEHOLDERS ============
async function featurePlaceholder(ctx, featureName) {
  await ctx.reply(
    `⚠️ *${featureName}*\n━━━━━━━━━━━━━━━━━━━━\n\nThis feature requires WhatsApp connection.\n\nPlease connect WhatsApp first.\n\n*Coming soon!*`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "main_menu")]]) }
  );
}

// ============ GROUP SELECTION (Mock) ============
async function mockGroupSelect(ctx, feature) {
  await ctx.reply(
    `☑️ *${feature}*\n━━━━━━━━━━━━━━━━━━━━\n\n⚠️ Please connect WhatsApp first to use this feature.\n\n*Demo Mode:* This is a preview of the feature.`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("📱 Connect WhatsApp", "connect_wa")],
      [Markup.button.callback("🏠 Main Menu", "main_menu")]
    ]) }
  );
}

// ============ ADMIN PANEL ============
async function sendAdminPanel(ctx) {
  const userId = ctx.from.id;
  const isAdmin = userId === OWNER_ID || ADMIN_IDS.includes(userId);
  
  if (!isAdmin) {
    await ctx.answerCbQuery("Admin only!", { show_alert: true });
    return;
  }
  
  const totalUsers = await User.countDocuments();
  const premiumUsers = await User.countDocuments({ isPremium: true });
  const bannedUsers = await User.countDocuments({ isBanned: true });
  
  await ctx.reply(
    `⚙️ *Admin Panel*\n━━━━━━━━━━━━━━━━━━━━\n📊 Stats:\n👥 Users: ${totalUsers}\n⭐ Premium: ${premiumUsers}\n🚫 Banned: ${bannedUsers}\n━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("👥 Users List", "admin_users")],
      [Markup.button.callback("⭐ Grant Premium", "admin_grant")],
      [Markup.button.callback("🔑 Generate Key", "admin_genkey")],
      [Markup.button.callback("🏠 Main Menu", "main_menu")]
    ]) }
  );
}

async function adminUsersList(ctx, page = 0) {
  const users = await User.find({}).sort({ createdAt: -1 }).skip(page * 10).limit(10);
  const total = await User.countDocuments();
  const totalPages = Math.ceil(total / 10);
  
  const buttons = [];
  for (const user of users) {
    buttons.push([Markup.button.callback(
      `${user.firstName?.slice(0, 15) || user.userId} ${user.isPremium ? "⭐" : ""}`,
      `admin_user_${user.userId}`
    )]);
  }
  
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("◀️", `admin_users_page_${page - 1}`));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, "admin_noop"));
  if (page < totalPages - 1) nav.push(Markup.button.callback("▶️", `admin_users_page_${page + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([Markup.button.callback("🔙 Back", "admin_menu")]);
  
  await ctx.editMessageText(`👥 *Users* (${page + 1}/${totalPages})`, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
}

async function adminUserDetail(ctx, targetId) {
  const user = await getUserById(targetId);
  if (!user) {
    await ctx.answerCbQuery("User not found");
    return;
  }
  
  await ctx.editMessageText(
    `👤 *User Details*\n━━━━━━━━━━━━━━━━━━━━\nID: \`${user.userId}\`\nName: ${user.firstName || "Unknown"}\n@${user.username || "N/A"}\n━━━━━━━━━━━━━━━━━━━━\n⭐ Premium: ${user.isPremium ? "✅" : "❌"}\n📅 Expires: ${user.premiumExpiry?.toLocaleDateString() || "Never"}\n🚫 Banned: ${user.isBanned ? "✅" : "❌"}\n🎁 Referrals: ${user.referralCount}\n━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("⭐ Grant Premium", `admin_grant_${targetId}`), Markup.button.callback("🗑️ Remove Premium", `admin_remove_${targetId}`)],
      [Markup.button.callback("🚫 Ban", `admin_ban_${targetId}`), Markup.button.callback("✅ Unban", `admin_unban_${targetId}`)],
      [Markup.button.callback("🔙 Back", "admin_users")]
    ]) }
  );
}

// ============ BOT ACTIONS ============
bot.action("main_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await sendMainMenu(ctx);
});

bot.action("connect_wa", async (ctx) => {
  await ctx.answerCbQuery();
  await connectWhatsApp(ctx);
});

bot.action("my_status", async (ctx) => {
  await ctx.answerCbQuery();
  await sendMyStatus(ctx);
});

bot.action("referral_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await sendReferralMenu(ctx);
});

// Feature actions (with placeholder)
bot.action("create_group", async (ctx) => {
  await ctx.answerCbQuery();
  await featurePlaceholder(ctx, "Create Group");
});

bot.action("join_group", async (ctx) => {
  await ctx.answerCbQuery();
  await featurePlaceholder(ctx, "Join Group");
});

bot.action("get_link", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Get Link");
});

bot.action("leave_group", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Leave Group");
});

bot.action("make_admin", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Make Admin");
});

bot.action("demote_admin", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Demote Admin");
});

bot.action("approve_pending", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Approve Pending");
});

bot.action("approval_mode", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Approval Mode");
});

bot.action("member_list", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Member List");
});

bot.action("pending_list", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Pending List");
});

bot.action("rename_group", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Rename Group");
});

bot.action("reset_link", async (ctx) => {
  await ctx.answerCbQuery();
  await mockGroupSelect(ctx, "Reset Link");
});

// Admin actions
bot.action("admin_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await sendAdminPanel(ctx);
});

bot.action("admin_users", async (ctx) => {
  await ctx.answerCbQuery();
  await adminUsersList(ctx, 0);
});

bot.action(/^admin_users_page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1]);
  await adminUsersList(ctx, page);
});

bot.action(/^admin_user_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  await adminUserDetail(ctx, targetId);
});

bot.action(/^admin_grant_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  await ctx.reply("⭐ *Grant Premium*\nSend duration (e.g., `30d`, `12h`, `1y`, `forever`):", { parse_mode: "Markdown" });
  ctx.session = { adminAction: "grant", targetId };
});

bot.action(/^admin_remove_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  await User.findOneAndUpdate({ userId: targetId }, { isPremium: false, premiumExpiry: null });
  await ctx.answerCbQuery("Premium removed!", { show_alert: true });
  await adminUserDetail(ctx, targetId);
});

bot.action(/^admin_ban_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  await User.findOneAndUpdate({ userId: targetId }, { isBanned: true });
  await ctx.answerCbQuery("User banned!", { show_alert: true });
  await adminUserDetail(ctx, targetId);
});

bot.action(/^admin_unban_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  await User.findOneAndUpdate({ userId: targetId }, { isBanned: false });
  await ctx.answerCbQuery("User unbanned!", { show_alert: true });
  await adminUserDetail(ctx, targetId);
});

bot.action("admin_grant", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("⭐ *Grant Premium*\nSend user ID and duration (e.g., `123456789 30d`):", { parse_mode: "Markdown" });
  ctx.session = { adminAction: "grant" };
});

bot.action("admin_genkey", async (ctx) => {
  await ctx.answerCbQuery();
  const crypto = require("crypto");
  const key = crypto.randomBytes(12).toString('hex').toUpperCase();
  await ctx.reply(`🔑 *Premium Key*\n\`${key}\`\n\nUser can redeem with: /redeem ${key}`, { parse_mode: "Markdown" });
});

bot.action("admin_noop", async (ctx) => {
  await ctx.answerCbQuery();
});

// ============ TEXT HANDLERS ============
bot.on("text", async (ctx) => {
  const text = ctx.message.text.trim();
  
  // Handle admin grant input
  if (ctx.session?.adminAction === "grant") {
    const parts = text.split(" ");
    let targetId, duration;
    
    if (ctx.session.targetId) {
      targetId = ctx.session.targetId;
      duration = text;
    } else if (parts.length >= 2) {
      targetId = parseInt(parts[0]);
      duration = parts[1];
    } else {
      targetId = parseInt(text);
      duration = "forever";
    }
    
    if (isNaN(targetId)) {
      await ctx.reply("❌ Invalid user ID!");
      return;
    }
    
    await grantPremium(targetId, duration);
    ctx.session = null;
    await ctx.reply(`✅ Premium granted to user ${targetId} for ${duration}!`);
    await sendMainMenu(ctx);
    return;
  }
  
  // Handle redeem command
  if (text.startsWith("/redeem")) {
    const parts = text.split(" ");
    if (parts.length < 2) {
      await ctx.reply("Usage: `/redeem KEY`", { parse_mode: "Markdown" });
      return;
    }
    await ctx.reply("✅ Premium activated! (Demo)", { parse_mode: "Markdown" });
    return;
  }
  
  await sendMainMenu(ctx);
});

// ============ COMMANDS ============
bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(" ");
  
  // Handle referral
  if (args.length > 1 && args[1].startsWith("ref_")) {
    const refCode = args[1].replace("ref_", "");
    const referrer = await User.findOne({ referralCode: refCode });
    if (referrer && referrer.userId !== userId) {
      await grantPremium(referrer.userId, "1d");
      await ctx.reply("🎉 You joined via referral! The referrer got 1 day premium.");
    }
  }
  
  await sendMainMenu(ctx);
});

bot.command("menu", async (ctx) => {
  await sendMainMenu(ctx);
});

bot.command("status", async (ctx) => {
  await sendMyStatus(ctx);
});

// ============ WEBHOOK SETUP ============
async function setupWebhook() {
  if (!WEBHOOK_URL) {
    console.log("⚠️ No WEBHOOK_URL set, using polling mode...");
    return false;
  }
  
  const webhookPath = `/webhook/${TOKEN}`;
  const webhookUrl = `${WEBHOOK_URL}${webhookPath}`;
  
  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`✅ Webhook set to: ${webhookUrl}`);
    return true;
  } catch (err) {
    console.error("❌ Webhook setup failed:", err.message);
    return false;
  }
}

// ============ EXPRESS SERVER ============
async function startServer() {
  await connectDB();
  
  const webhookEnabled = await setupWebhook();
  
  if (webhookEnabled) {
    // Webhook mode
    app.use(express.json());
    app.post(`/webhook/${TOKEN}`, (req, res) => {
      bot.handleUpdate(req.body, res);
    });
    
    app.get("/", (req, res) => {
      res.send("✅ Bot is running!");
    });
    
    app.get("/health", (req, res) => {
      res.json({ status: "ok", timestamp: new Date().toISOString() });
    });
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`✅ Bot is ready!`);
    });
  } else {
    // Polling mode (for local testing)
    await bot.launch({ dropPendingUpdates: true });
    console.log("✅ Bot started in polling mode");
  }
  
  console.log(`👤 Owner ID: ${OWNER_ID}`);
  console.log(`👥 Admin IDs: ${ADMIN_IDS.join(", ")}`);
}

// ============ DB CONNECTION ============
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI not set!");
  
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 10
  });
  console.log("✅ MongoDB connected");
}

// ============ START ============
startServer().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Graceful shutdown
process.once("SIGINT", () => {
  bot.stop("SIGINT");
  mongoose.disconnect();
  process.exit(0);
});
process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
  mongoose.disconnect();
  process.exit(0);
});