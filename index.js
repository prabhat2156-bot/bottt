/**
 * WhatsApp Automation Bot - Complete Production Version
 * Optimized for Render Free Plan
 */
const { Telegraf, Markup } = require("telegraf");
const { connectDB } = require("./src/db");
const { 
  getUserFlow, setUserFlow, clearUserFlow,
  setActiveOperation, clearActiveOperation,
  defaultGroupFlow, defaultFeatureFlow 
} = require("./src/session");
const {
  connectUser, disconnectUser, getUserStatus, getUserPhone, getSocket,
  getAllGroups, getGroupInviteLink, leaveGroup, renameGroup,
  getGroupMembers, getGroupPending, approvePending,
  setApprovalMode, getApprovalMode, makeAdmin, demoteAdmin,
  joinGroupViaLink, getGroupInfo, createGroup, setGroupDesc,
  setGroupPhoto, setDisappearing, addMembers, removeMembers, resetInviteLink
} = require("./src/whatsapp-manager");
const {
  createOrUpdateUser, getUserById, getAllUsers, getUserStats,
  grantPremium, removePremium, banUser, unbanUser, createPremiumKey,
  redeemKey, addReferral, getUserProfile, adminMenuKeyboard, usersListKeyboard
} = require("./src/admin");
const express = require("express");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set!"); process.exit(1); }
const OWNER_ID = parseInt(process.env.OWNER_ID || "0", 10);
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(id => parseInt(id, 10)).filter(id => !isNaN(id));

const bot = new Telegraf(TOKEN);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAGE_SIZE = 10;

// Global state
let isPremiumMode = false;
global.userCallbacks = new Map();

// Garbage collection every 30 seconds
setInterval(() => { if (global.gc) global.gc(); }, 30000);

// Rate limiting per user
const userCooldown = new Map();

// Middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();
  
  // Rate limit
  const now = Date.now();
  const last = userCooldown.get(userId);
  if (last && now - last < 500) return;
  userCooldown.set(userId, now);
  
  // Create/update user
  const user = await createOrUpdateUser(userId, ctx.from.username, ctx.from.first_name, ctx.from.last_name);
  
  // Check ban
  if (user.isBanned) {
    if (ctx.callbackQuery) await ctx.answerCbQuery("⛔ You are banned!", { show_alert: true });
    else await ctx.reply("⛔ You are banned from using this bot.");
    return;
  }
  
  // Premium mode check
  const isAdmin = userId === OWNER_ID || ADMIN_IDS.includes(userId);
  if (isPremiumMode && !user.isPremium && !isAdmin) {
    await ctx.reply("⭐ *Premium Mode Active*\n\nThis bot is currently in premium mode.\nOnly premium users can access.\n\nUse `/redeem KEY` to activate premium.", { parse_mode: "Markdown" });
    return;
  }
  
  // Update command count
  if (ctx.message?.text && !ctx.message.text.startsWith("/")) {
    user.totalCommands++;
    await user.save();
  }
  
  return next();
});

// Callback handlers
global.userCallbacks.set("global", {
  onPairingCode: async (userId, code) => {
    try { await bot.telegram.sendMessage(userId, `🔑 *Pairing Code*\n━━━━━━━━━━━━━━━━━━━━\n\`${code}\`\n\nEnter this code in WhatsApp Linked Devices.`, { parse_mode: "Markdown" }); } 
    catch(e) {}
  },
  onReady: async (userId) => {
    try { await bot.telegram.sendMessage(userId, "✅ *WhatsApp Connected!*\n\nYou can now use all features.", { parse_mode: "Markdown" }); } 
    catch(e) {}
  },
  onDisconnected: async (userId, isLoggedOut) => {
    try { 
      await bot.telegram.sendMessage(userId, 
        `⚠️ *WhatsApp Disconnected!*\n\n${isLoggedOut ? "Session expired. Please reconnect." : "Connection lost. Tap Connect to reconnect."}`,
        { parse_mode: "Markdown" }
      );
    } catch(e) {}
  }
});

// Main Menu
async function sendMainMenu(ctx) {
  const userId = ctx.from.id;
  clearUserFlow(userId);
  clearActiveOperation(userId);
  
  const user = await getUserById(userId);
  const status = await getUserStatus(userId);
  const phone = await getUserPhone(userId);
  const isPremium = user?.isPremium && (!user?.premiumExpiry || user.premiumExpiry > new Date());
  const expiryText = user?.premiumExpiry ? new Date(user.premiumExpiry).toLocaleDateString() : "Never";
  
  const modeIcon = isPremiumMode ? "🔒" : "🆓";
  const premiumIcon = isPremium ? "⭐" : "🆓";
  
  const menuText = `🤖 *WhatsApp Bot*\n━━━━━━━━━━━━━━━━━━━━\n👤 ${user?.firstName || "User"}\n${modeIcon} Mode: ${isPremiumMode ? "Premium" : "Free"}\n${premiumIcon} Status: ${isPremium ? "Premium" : "Free"}\n📅 Expiry: ${expiryText}\n━━━━━━━━━━━━━━━━━━━━\n📱 WA: ${status === "connected" ? `✅ +${phone}` : status === "connecting" ? "⏳..." : "❌ Disconnected"}\n━━━━━━━━━━━━━━━━━━━━`;
  
  const buttons = [
    [Markup.button.callback(status === "connected" ? "📱 WhatsApp ✅" : "📱 Connect WA", "menu_connect")],
    [Markup.button.callback("➕ Create Group", "feat_create"), Markup.button.callback("🔗 Join Group", "feat_join")],
    [Markup.button.callback("🔗 Get Link", "feat_link"), Markup.button.callback("🚪 Leave Group", "feat_leave")],
    [Markup.button.callback("👑 Make Admin", "feat_makeadmin"), Markup.button.callback("⬇️ Demote Admin", "feat_demote")],
    [Markup.button.callback("✅ Approve Pending", "feat_approve"), Markup.button.callback("🔀 Approval Mode", "feat_approval")],
    [Markup.button.callback("📋 Member List", "feat_members"), Markup.button.callback("👥 Pending List", "feat_pending")],
    [Markup.button.callback("➕ Add Member", "feat_add"), Markup.button.callback("🧹 Remove All", "feat_remove")],
    [Markup.button.callback("✏️ Rename", "feat_rename"), Markup.button.callback("🔄 Reset Link", "feat_reset")],
    [Markup.button.callback("📊 My Status", "menu_status"), Markup.button.callback("🎁 Referral", "menu_referral")]
  ];
  
  const isAdmin = userId === OWNER_ID || ADMIN_IDS.includes(userId);
  if (isAdmin) buttons.push([Markup.button.callback("⚙️ Admin Panel", "admin_menu")]);
  
  await ctx.reply(menuText, { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) });
}

// My Status Menu
async function sendStatusMenu(ctx) {
  const userId = ctx.from.id;
  const profile = await getUserProfile(userId);
  if (!profile) return await sendMainMenu(ctx);
  
  const statusText = `📊 *My Status*\n━━━━━━━━━━━━━━━━━━━━\n👤 Name: ${profile.name}\n🆔 ID: \`${profile.userId}\`\n@${profile.username || "No username"}\n━━━━━━━━━━━━━━━━━━━━\n⭐ Premium: ${profile.isPremium ? "✅ Active" : "❌ Inactive"}\n📅 Expires: ${profile.premiumExpiry}\n━━━━━━━━━━━━━━━━━━━━\n🎁 Referral Code: \`${profile.referralCode}\`\n👥 Referrals: ${profile.referralCount}\n💬 Commands: ${profile.totalCommands}\n📅 Joined: ${profile.joinedAt}\n━━━━━━━━━━━━━━━━━━━━`;
  
  await ctx.editMessageText(statusText, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]])
  });
}

// Referral Menu
async function sendReferralMenu(ctx) {
  const userId = ctx.from.id;
  const user = await getUserById(userId);
  const botUsername = ctx.botInfo.username;
  const link = `https://t.me/${botUsername}?start=ref_${user?.referralCode}`;
  
  await ctx.editMessageText(
    `🎁 *Referral Program*\n━━━━━━━━━━━━━━━━━━━━\n\nYour Code: \`${user?.referralCode}\`\n\nInvite Link:\n${link}\n\nReferred: ${user?.referralCount || 0} users\n\n*Reward:* 1 day premium per referral!\n\nShare your link and get premium!`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) }
  );
}

// WhatsApp Connection
async function connectWAMenu(ctx) {
  const userId = ctx.from.id;
  const status = await getUserStatus(userId);
  const phone = await getUserPhone(userId);
  
  if (status === "connected") {
    await ctx.editMessageText(
      `📱 *WhatsApp Connected*\n━━━━━━━━━━━━━━━━━━━━\n✅ +${phone}\n━━━━━━━━━━━━━━━━━━━━\nDisconnect?`,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([
        [Markup.button.callback("🔌 Disconnect", "menu_disconnect")],
        [Markup.button.callback("🏠 Main Menu", "back_menu")]
      ]) }
    );
  } else {
    setUserFlow(userId, { step: "awaiting_phone" });
    await ctx.editMessageText(
      `📱 *Connect WhatsApp*\n━━━━━━━━━━━━━━━━━━━━\n\nSend your phone number with country code:\n\n*Example:* \`919876543210\``,
      { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) }
    );
  }
}

// Group Selection
async function selectGroups(ctx, feature) {
  const userId = ctx.from.id;
  try {
    const groups = await getAllGroups(userId);
    if (!groups.length) {
      await ctx.reply("❌ No groups found.", Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]));
      return;
    }
    setUserFlow(userId, { feature, groups, selected: [], page: 0, step: "select" });
    await showGroupPage(ctx);
  } catch(err) {
    await ctx.reply(`❌ Error: ${err.message}`);
  }
}

async function showGroupPage(ctx) {
  const userId = ctx.from.id;
  const flow = getUserFlow(userId);
  if (!flow?.groups) return;
  
  const { groups, selected, page } = flow;
  const start = page * PAGE_SIZE;
  const pageGroups = groups.slice(start, start + PAGE_SIZE);
  const totalPages = Math.ceil(groups.length / PAGE_SIZE);
  const selectedSet = new Set(selected);
  
  const buttons = [];
  for (let i = 0; i < pageGroups.length; i++) {
    const idx = start + i;
    const g = pageGroups[i];
    const name = g.name.length > 35 ? g.name.slice(0, 32) + "..." : g.name;
    buttons.push([Markup.button.callback(`${selectedSet.has(g.id) ? "✅" : "◻️"} ${name}`, `group_toggle_${idx}`)]);
  }
  
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("◀️", "group_prev"));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, "group_noop"));
  if (page < totalPages - 1) nav.push(Markup.button.callback("▶️", "group_next"));
  if (nav.length) buttons.push(nav);
  buttons.push([Markup.button.callback(`✅ Confirm (${selected.length})`, "group_confirm")]);
  buttons.push([Markup.button.callback("🏠 Main Menu", "back_menu")]);
  
  await ctx.editMessageText(
    `☑️ *Select Groups* - ${page + 1}/${totalPages}\n━━━━━━━━━━━━━━━━━━━━\nTotal: ${groups.length} | Selected: ${selected.length}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
  );
}

// Feature Runner
async function runFeature(ctx, feature, groups, extra = null) {
  const userId = ctx.from.id;
  const total = groups.length;
  let done = 0, failed = 0, cancelled = false;
  const results = [];
  
  const msg = await ctx.reply(`⏳ ${feature} - 0/${total}`);
  setActiveOperation(userId, feature);
  
  for (let i = 0; i < total; i++) {
    const flow = getUserFlow(userId);
    if (flow?.cancelled) { cancelled = true; break; }
    
    const g = groups[i];
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `⏳ ${feature}\n${i + 1}/${total}\n→ ${g.name.slice(0, 30)}`);
      
      if (feature === "get_link") {
        const link = await getGroupInviteLink(userId, g.id);
        results.push(`${g.name}\n${link}`);
      }
      else if (feature === "leave") await leaveGroup(userId, g.id);
      else if (feature === "rename") await renameGroup(userId, g.id, extra);
      else if (feature === "make_admin") await makeAdmin(userId, g.id, extra);
      else if (feature === "demote_admin") await demoteAdmin(userId, g.id, extra);
      else if (feature === "approval_toggle") {
        const cur = await getApprovalMode(userId, g.id);
        await setApprovalMode(userId, g.id, !cur);
      }
      else if (feature === "approve_pending") {
        const pending = await getGroupPending(userId, g.id);
        const jids = pending.map(p => p.jid || p.id).filter(Boolean);
        if (jids.length) await approvePending(userId, g.id, jids);
        results.push(`${g.name}: ${jids.length} approved`);
      }
      else if (feature === "member_list") {
        const members = await getGroupMembers(userId, g.id);
        results.push(`${g.name}: ${members.length} members`);
      }
      else if (feature === "pending_list") {
        const pending = await getGroupPending(userId, g.id);
        results.push(`${g.name}: ${pending.length} pending`);
      }
      else if (feature === "add_member") {
        const added = await addMembers(userId, g.id, extra);
        results.push(`${g.name}: +${added}`);
      }
      else if (feature === "remove_members") {
        const removed = await removeMembers(userId, g.id);
        results.push(`${g.name}: -${removed}`);
      }
      else if (feature === "reset_link") {
        const link = await resetInviteLink(userId, g.id);
        results.push(`${g.name}\n${link}`);
      }
      done++;
    } catch(err) {
      failed++;
      results.push(`❌ ${g.name}: ${err.message.slice(0, 50)}`);
    }
    await sleep(2000);
  }
  
  clearActiveOperation(userId);
  await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, 
    `✅ *${feature} Complete*\n━━━━━━━━━━━━━━━━━━━━\nTotal: ${total}\nSuccess: ${done}\nFailed: ${failed}\n${cancelled ? "Cancelled" : ""}`,
    { parse_mode: "Markdown" }
  );
  
  if (results.length) {
    for (let i = 0; i < results.length; i += 15) {
      await ctx.reply("```\n" + results.slice(i, i + 15).join("\n") + "\n```", { parse_mode: "Markdown" });
      await sleep(500);
    }
  }
  
  await sendMainMenu(ctx);
}

// Create Group Flow
async function createGroupFlow(ctx) {
  const userId = ctx.from.id;
  setUserFlow(userId, defaultGroupFlow());
  await ctx.reply("➕ *Create Group*\n━━━━━━━━━━━━━━━━━━━━\n\n*Group name?*", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "back_menu")]]) });
}

// Join Group Flow
async function joinGroupFlow(ctx) {
  const userId = ctx.from.id;
  setUserFlow(userId, { step: "join_links" });
  await ctx.reply("🔗 *Join Group*\n━━━━━━━━━━━━━━━━━━━━\n\nSend invite links (one per line):", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("❌ Cancel", "back_menu")]]) });
}

// ============ BOT ACTIONS ============

bot.action("back_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await sendMainMenu(ctx);
});

bot.action("menu_connect", async (ctx) => {
  await ctx.answerCbQuery();
  await connectWAMenu(ctx);
});

bot.action("menu_disconnect", async (ctx) => {
  await ctx.answerCbQuery("Disconnecting...");
  await disconnectUser(ctx.from.id);
  await sendMainMenu(ctx);
});

bot.action("menu_status", async (ctx) => {
  await ctx.answerCbQuery();
  await sendStatusMenu(ctx);
});

bot.action("menu_referral", async (ctx) => {
  await ctx.answerCbQuery();
  await sendReferralMenu(ctx);
});

// Feature actions
bot.action("feat_create", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await createGroupFlow(ctx);
});

bot.action("feat_join", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await joinGroupFlow(ctx);
});

bot.action("feat_link", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "get_link");
});

bot.action("feat_leave", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "leave");
});

bot.action("feat_makeadmin", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "make_admin");
});

bot.action("feat_demote", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "demote_admin");
});

bot.action("feat_approve", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "approve_pending");
});

bot.action("feat_approval", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "approval_toggle");
});

bot.action("feat_members", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "member_list");
});

bot.action("feat_pending", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "pending_list");
});

bot.action("feat_add", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "add_member");
});

bot.action("feat_remove", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "remove_members");
});

bot.action("feat_rename", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  setUserFlow(ctx.from.id, { step: "rename_name", groups: null });
  await ctx.reply("✏️ *Rename Groups*\n━━━━━━━━━━━━━━━━━━━━\n\nSend the new name:", { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
});

bot.action("feat_reset", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await getUserStatus(ctx.from.id);
  if (status !== "connected") { await ctx.answerCbQuery("Connect WhatsApp first!", { show_alert: true }); return; }
  await selectGroups(ctx, "reset_link");
});

// Group selection handlers
bot.action(/^group_toggle_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const flow = getUserFlow(userId);
  if (!flow?.groups) return;
  
  const idx = parseInt(ctx.match[1]);
  const group = flow.groups[idx];
  if (!group) return;
  
  const selected = new Set(flow.selected);
  if (selected.has(group.id)) selected.delete(group.id);
  else selected.add(group.id);
  
  setUserFlow(userId, { ...flow, selected: [...selected] });
  await showGroupPage(ctx);
});

bot.action("group_prev", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const flow = getUserFlow(userId);
  if (flow && flow.page > 0) {
    setUserFlow(userId, { ...flow, page: flow.page - 1 });
    await showGroupPage(ctx);
  }
});

bot.action("group_next", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const flow = getUserFlow(userId);
  const totalPages = Math.ceil(flow.groups.length / PAGE_SIZE);
  if (flow && flow.page < totalPages - 1) {
    setUserFlow(userId, { ...flow, page: flow.page + 1 });
    await showGroupPage(ctx);
  }
});

bot.action("group_noop", async (ctx) => { await ctx.answerCbQuery(); });

bot.action("group_confirm", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const flow = getUserFlow(userId);
  if (!flow?.selected?.length) {
    await ctx.answerCbQuery("Select at least one group!", { show_alert: true });
    return;
  }
  
  const selectedGroups = flow.groups.filter(g => flow.selected.includes(g.id));
  const feature = flow.feature;
  
  if (feature === "make_admin" || feature === "demote_admin") {
    setUserFlow(userId, { step: "admin_numbers", feature, groups: selectedGroups });
    await ctx.reply(`👑 *${feature === "make_admin" ? "Make Admin" : "Demote Admin"}*\n━━━━━━━━━━━━━━━━━━━━\n\nSend phone numbers (one per line):`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
  } 
  else if (feature === "add_member") {
    setUserFlow(userId, { step: "add_numbers", feature, groups: selectedGroups });
    await ctx.reply(`➕ *Add Members*\n━━━━━━━━━━━━━━━━━━━━\n\nSend phone numbers (one per line):`, { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Main Menu", "back_menu")]]) });
  }
  else {
    await runFeature(ctx, feature, selectedGroups);
    clearUserFlow(userId);
  }
});

// ============ ADMIN PANEL ============
bot.action("admin_menu", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const isAdmin = userId === OWNER_ID || ADMIN_IDS.includes(userId);
  if (!isAdmin) { await ctx.answerCbQuery("Admin only!", { show_alert: true }); return; }
  
  const stats = await getUserStats();
  await ctx.editMessageText(
    `⚙️ *Admin Panel*\n━━━━━━━━━━━━━━━━━━━━\n📊 Stats:\n👥 Users: ${stats.total}\n⭐ Premium: ${stats.premium}\n🚫 Banned: ${stats.banned}\n🟢 Active: ${stats.active}\n━━━━━━━━━━━━━━━━━━━━\n🔀 Mode: ${isPremiumMode ? "Premium" : "Free"}`,
    { parse_mode: "Markdown", ...adminMenuKeyboard() }
  );
});

bot.action("admin_dashboard", async (ctx) => {
  await ctx.answerCbQuery();
  const stats = await getUserStats();
  await ctx.editMessageText(
    `📊 *Dashboard*\n━━━━━━━━━━━━━━━━━━━━\n👥 Total Users: ${stats.total}\n⭐ Premium: ${stats.premium}\n🚫 Banned: ${stats.banned}\n🟢 Active Today: ${stats.active}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_menu")]]) }
  );
});

bot.action("admin_users", async (ctx) => {
  await ctx.answerCbQuery();
  const { users, totalPages } = await getAllUsers(0);
  await ctx.editMessageText(
    `👥 *Users* (1/${totalPages})`,
    { parse_mode: "Markdown", ...usersListKeyboard(users, 0, totalPages) }
  );
});

bot.action(/^admin_page_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const page = parseInt(ctx.match[1]);
  const { users, totalPages } = await getAllUsers(page);
  await ctx.editMessageText(
    `👥 *Users* (${page + 1}/${totalPages})`,
    { parse_mode: "Markdown", ...usersListKeyboard(users, page, totalPages) }
  );
});

bot.action(/^admin_user_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = parseInt(ctx.match[1]);
  const user = await getUserById(userId);
  if (!user) { await ctx.answerCbQuery("User not found"); return; }
  
  await ctx.editMessageText(
    `👤 *User Details*\n━━━━━━━━━━━━━━━━━━━━\nID: \`${user.userId}\`\nName: ${user.firstName || "Unknown"}\n@${user.username || "N/A"}\n━━━━━━━━━━━━━━━━━━━━\n⭐ Premium: ${user.isPremium ? "✅" : "❌"}\n📅 Expires: ${user.premiumExpiry?.toLocaleDateString() || "Never"}\n🚫 Banned: ${user.isBanned ? "✅" : "❌"}\n🎁 Referrals: ${user.referralCount}\n━━━━━━━━━━━━━━━━━━━━`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard([
      [Markup.button.callback("⭐ Grant Premium", `admin_grant_${userId}`), Markup.button.callback("🗑️ Remove", `admin_remove_${userId}`)],
      [Markup.button.callback("🚫 Ban", `admin_ban_${userId}`), Markup.button.callback("✅ Unban", `admin_unban_${userId}`)],
      [Markup.button.callback("🔙 Back", "admin_users")]
    ]) }
  );
});

bot.action(/^admin_grant_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = parseInt(ctx.match[1]);
  setUserFlow(ctx.from.id, { step: "admin_grant", targetId });
  await ctx.reply("⭐ *Grant Premium*\n━━━━━━━━━━━━━━━━━━━━\n\nSend duration (e.g., `30d`, `12h`, `1y`, `forever`):", { parse_mode: "Markdown" });
});

bot.action(/^admin_remove_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await removePremium(parseInt(ctx.match[1]));
  await ctx.answerCbQuery("Premium removed!", { show_alert: true });
});

bot.action(/^admin_ban_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await banUser(parseInt(ctx.match[1]));
  await ctx.answerCbQuery("User banned!", { show_alert: true });
});

bot.action(/^admin_unban_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await unbanUser(parseInt(ctx.match[1]));
  await ctx.answerCbQuery("User unbanned!", { show_alert: true });
});

bot.action("admin_grant", async (ctx) => {
  await ctx.answerCbQuery();
  setUserFlow(ctx.from.id, { step: "admin_grant" });
  await ctx.reply("⭐ *Grant Premium*\nSend user ID and duration (e.g., `123456789 30d`):");
});

bot.action("admin_remove", async (ctx) => {
  await ctx.answerCbQuery();
  setUserFlow(ctx.from.id, { step: "admin_remove" });
  await ctx.reply("🗑️ *Remove Premium*\nSend user ID:");
});

bot.action("admin_genkey", async (ctx) => {
  await ctx.answerCbQuery();
  setUserFlow(ctx.from.id, { step: "admin_genkey" });
  await ctx.reply("🔑 *Generate Key*\nFormat: `DURATION MAX_USES`\nExamples: `30d 1`, `7d 5`, `1y 100`");
});

bot.action("admin_ban", async (ctx) => {
  await ctx.answerCbQuery();
  setUserFlow(ctx.from.id, { step: "admin_ban" });
  await ctx.reply("🚫 *Ban User*\nSend user ID:");
});

bot.action("admin_toggle_mode", async (ctx) => {
  await ctx.answerCbQuery();
  isPremiumMode = !isPremiumMode;
  await ctx.answerCbQuery(`Mode: ${isPremiumMode ? "Premium" : "Free"}`, { show_alert: true });
  await ctx.editMessageText(`✅ Mode switched to ${isPremiumMode ? "Premium" : "Free"} mode`, { reply_markup: Markup.inlineKeyboard([[Markup.button.callback("🔙 Back", "admin_menu")]]).reply_markup });
});

bot.action("admin_noop", async (ctx) => { await ctx.answerCbQuery(); });

// ============ TEXT HANDLERS ============
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return;
  
  const flow = getUserFlow(userId);
  
  // WhatsApp connection
  if (flow?.step === "awaiting_phone") {
    const phone = text.replace(/\D/g, "");
    if (phone.length < 10) {
      await ctx.reply("❌ Invalid number. Example: `919876543210`", { parse_mode: "Markdown" });
      return;
    }
    clearUserFlow(userId);
    await ctx.reply("⏳ *Connecting...*", { parse_mode: "Markdown" });
    
    global.userCallbacks.set(userId, {
      onPairingCode: async (code) => await ctx.reply(`🔑 *Pairing Code*\n\`${code}\``, { parse_mode: "Markdown" }),
      onReady: async () => await sendMainMenu(ctx),
      onDisconnected: async () => await ctx.reply("⚠️ Disconnected")
    });
    
    await connectUser(userId, phone);
    return;
  }
  
  // Join group links
  if (flow?.step === "join_links") {
    const codes = [...text.matchAll(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/g)].map(m => m[1]);
    if (!codes.length) {
      await ctx.reply("❌ No valid links found.");
      return;
    }
    clearUserFlow(userId);
    const msg = await ctx.reply(`⏳ Joining ${codes.length} groups...`);
    let joined = 0;
    for (const code of codes) {
      try {
        await joinGroupViaLink(userId, code);
        joined++;
      } catch(e) {}
      await sleep(2500);
    }
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Joined ${joined}/${codes.length} groups`);
    await sendMainMenu(ctx);
    return;
  }
  
  // Admin numbers for make/demote admin
  if (flow?.step === "admin_numbers") {
    const numbers = text.split(/\n/).map(n => n.trim()).filter(n => n.length > 0);
    if (!numbers.length) {
      await ctx.reply("❌ No numbers found.");
      return;
    }
    const groups = flow.groups;
    clearUserFlow(userId);
    await runFeature(ctx, flow.feature, groups, numbers);
    return;
  }
  
  // Add members numbers
  if (flow?.step === "add_numbers") {
    const numbers = text.split(/\n/).map(n => n.trim()).filter(n => n.length > 0);
    if (!numbers.length) {
      await ctx.reply("❌ No numbers found.");
      return;
    }
    const groups = flow.groups;
    clearUserFlow(userId);
    await runFeature(ctx, "add_member", groups, numbers);
    return;
  }
  
  // Rename
  if (flow?.step === "rename_name") {
    const newName = text.slice(0, 60);
    setUserFlow(userId, { step: "rename_groups", newName });
    await selectGroups(ctx, "rename");
    return;
  }
  
  // Admin grant
  if (flow?.step === "admin_grant") {
    const parts = text.split(" ");
    let targetId, durationStr;
    
    if (flow.targetId) {
      targetId = flow.targetId;
      durationStr = text;
    } else if (parts.length >= 2) {
      targetId = parseInt(parts[0]);
      durationStr = parts[1];
    } else {
      targetId = parseInt(text);
      durationStr = "forever";
    }
    
    if (isNaN(targetId)) {
      await ctx.reply("❌ Invalid user ID!");
      return;
    }
    
    let durationMs = 0;
    if (durationStr === "forever") durationMs = 1000 * 365 * 24 * 60 * 60 * 1000;
    else {
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
    
    await grantPremium(targetId, durationMs);
    clearUserFlow(userId);
    await ctx.reply(`✅ Premium granted to user ${targetId} for ${durationStr}!`);
    await sendMainMenu(ctx);
    return;
  }
  
  // Admin remove
  if (flow?.step === "admin_remove") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid user ID!"); return; }
    await removePremium(targetId);
    clearUserFlow(userId);
    await ctx.reply(`✅ Premium removed from user ${targetId}`);
    await sendMainMenu(ctx);
    return;
  }
  
  // Admin genkey
  if (flow?.step === "admin_genkey") {
    const parts = text.split(" ");
    if (parts.length !== 2) { await ctx.reply("❌ Format: `30d 1` or `7d 5`"); return; }
    
    const durationStr = parts[0];
    const maxUses = parseInt(parts[1]);
    
    let durationMs = 0;
    if (durationStr === "forever") durationMs = 1000 * 365 * 24 * 60 * 60 * 1000;
    else {
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
    
    const key = await createPremiumKey(durationMs, maxUses);
    clearUserFlow(userId);
    await ctx.reply(`🔑 *Key Generated*\n\`${key}\`\nDuration: ${durationStr}\nUses: ${maxUses}`, { parse_mode: "Markdown" });
    await sendMainMenu(ctx);
    return;
  }
  
  // Admin ban
  if (flow?.step === "admin_ban") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) { await ctx.reply("❌ Invalid user ID!"); return; }
    await banUser(targetId);
    clearUserFlow(userId);
    await ctx.reply(`🚫 User ${targetId} banned!`);
    await sendMainMenu(ctx);
    return;
  }
  
  await sendMainMenu(ctx);
});

// ============ COMMANDS ============
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(" ");
  
  // Referral handling
  if (args.length > 1 && args[1].startsWith("ref_")) {
    const refCode = args[1].replace("ref_", "");
    const referrer = await getUserById(userId);
    if (referrer?.referralCode !== refCode) {
      await addReferral(userId, referrer?.userId);
    }
  }
  
  await sendMainMenu(ctx);
});

bot.command("redeem", async (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length < 2) {
    await ctx.reply("🔑 *Redeem Key*\n\nUsage: `/redeem KEY`", { parse_mode: "Markdown" });
    return;
  }
  const result = await redeemKey(ctx.from.id, args[1]);
  await ctx.reply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`, { parse_mode: "Markdown" });
});

bot.command("menu", async (ctx) => {
  await sendMainMenu(ctx);
});

// ============ HEALTH SERVER ============
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("✅ Bot Running"));
app.get("/health", (_, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));
app.listen(PORT, () => console.log(`HTTP server on port ${PORT}`));

// ============ MAIN ============
async function main() {
  await connectDB();
  await bot.launch({ dropPendingUpdates: true });
  console.log(`✅ Bot running! Owner: ${OWNER_ID}`);
  console.log(`Premium Mode: ${isPremiumMode ? "ON" : "OFF"}`);
}

main().catch(console.error);
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
