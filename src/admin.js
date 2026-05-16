/**
 * Admin functions with referral system
 */
const { Markup } = require("telegraf");
const { User, PremiumKey } = require("./models");
const crypto = require("crypto");

function generateKey() {
  return crypto.randomBytes(12).toString('hex').toUpperCase();
}

async function createOrUpdateUser(userId, username, firstName, lastName) {
  let user = await User.findOne({ userId });
  if (!user) {
    const referralCode = generateKey().slice(0, 8);
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

async function getAllUsers(page = 0, limit = 20) {
  const users = await User.find({}).sort({ createdAt: -1 }).skip(page * limit).limit(limit);
  const total = await User.countDocuments();
  return { users, total, totalPages: Math.ceil(total / limit) };
}

async function getUserStats() {
  const total = await User.countDocuments();
  const premium = await User.countDocuments({ isPremium: true, premiumExpiry: { $gt: new Date() } });
  const banned = await User.countDocuments({ isBanned: true });
  const active = await User.countDocuments({ lastActive: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
  return { total, premium, banned, active };
}

async function grantPremium(userId, durationMs) {
  const expiry = durationMs > 0 ? new Date(Date.now() + durationMs) : null;
  return await User.findOneAndUpdate(
    { userId },
    { isPremium: true, premiumExpiry: expiry },
    { upsert: true, new: true }
  );
}

async function removePremium(userId) {
  return await User.findOneAndUpdate(
    { userId },
    { isPremium: false, premiumExpiry: null },
    { new: true }
  );
}

async function banUser(userId) {
  return await User.findOneAndUpdate({ userId }, { isBanned: true }, { upsert: true });
}

async function unbanUser(userId) {
  return await User.findOneAndUpdate({ userId }, { isBanned: false });
}

async function createPremiumKey(durationMs, maxUses = 1) {
  const key = generateKey();
  const premiumKey = new PremiumKey({ key, duration: durationMs, maxUses });
  await premiumKey.save();
  return key;
}

async function redeemKey(userId, keyCode) {
  const key = await PremiumKey.findOne({ key: keyCode });
  if (!key) return { success: false, message: "Invalid key!" };
  if (key.usedCount >= key.maxUses) return { success: false, message: "Key already used!" };
  if (key.usedBy.includes(userId)) return { success: false, message: "You already used this key!" };
  
  key.usedBy.push(userId);
  key.usedCount++;
  await key.save();
  
  await grantPremium(userId, key.duration);
  return { success: true, message: "Premium activated!" };
}

async function addReferral(userId, referrerId) {
  const user = await User.findOne({ userId });
  if (user && !user.referredBy && referrerId !== userId) {
    user.referredBy = referrerId;
    await user.save();
    
    // Give 1 day premium to referrer
    await grantPremium(referrerId, 24 * 60 * 60 * 1000);
    
    // Increment referral count
    await User.findOneAndUpdate({ userId: referrerId }, { $inc: { referralCount: 1 } });
    
    return true;
  }
  return false;
}

async function getUserProfile(userId) {
  const user = await getUserById(userId);
  if (!user) return null;
  
  const premiumActive = user.isPremium && (!user.premiumExpiry || user.premiumExpiry > new Date());
  const premiumExpiry = user.premiumExpiry ? user.premiumExpiry.toLocaleString() : "Never";
  
  return {
    userId: user.userId,
    name: user.firstName || user.username || "Unknown",
    username: user.username,
    isPremium: premiumActive,
    premiumExpiry,
    isBanned: user.isBanned,
    totalCommands: user.totalCommands,
    referralCode: user.referralCode,
    referralCount: user.referralCount,
    joinedAt: user.createdAt.toLocaleString(),
    lastActive: user.lastActive.toLocaleString()
  };
}

function adminMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Dashboard", "admin_dashboard")],
    [Markup.button.callback("👥 Users List", "admin_users")],
    [Markup.button.callback("⭐ Grant Premium", "admin_grant")],
    [Markup.button.callback("🗑️ Remove Premium", "admin_remove")],
    [Markup.button.callback("🔑 Generate Key", "admin_genkey")],
    [Markup.button.callback("🚫 Ban/Unban", "admin_ban")],
    [Markup.button.callback("🔀 Toggle Premium Mode", "admin_toggle_mode")],
    [Markup.button.callback("🏠 Main Menu", "back_menu")]
  ]);
}

function usersListKeyboard(users, page, totalPages) {
  const buttons = [];
  for (const user of users.slice(0, 8)) {
    buttons.push([Markup.button.callback(
      `${user.firstName?.slice(0, 15) || user.userId} ${user.isPremium ? "⭐" : ""}`,
      `admin_user_${user.userId}`
    )]);
  }
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("◀️", `admin_page_${page - 1}`));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, "admin_noop"));
  if (page < totalPages - 1) nav.push(Markup.button.callback("▶️", `admin_page_${page + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([Markup.button.callback("🔙 Back", "admin_menu")]);
  return Markup.inlineKeyboard(buttons);
}

module.exports = {
  generateKey, createOrUpdateUser, getUserById, getAllUsers, getUserStats,
  grantPremium, removePremium, banUser, unbanUser, createPremiumKey, redeemKey,
  addReferral, getUserProfile, adminMenuKeyboard, usersListKeyboard
};
