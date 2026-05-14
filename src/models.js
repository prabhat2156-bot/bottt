const mongoose = require("mongoose");
const { Schema } = mongoose;

// ── Auth State ────────────────────────────────────────────────────────────────
const AuthStateSchema = new Schema(
  {
    accountId: { type: String, required: true },
    type:      { type: String, required: true },
    data:      { type: String, required: true },
  },
  { collection: "auth_states" }
);
AuthStateSchema.index({ accountId: 1, type: 1 }, { unique: true });

// ── Account Info (per-user WhatsApp session) ──────────────────────────────────
const AccountInfoSchema = new Schema(
  {
    userId:      { type: String, required: true, unique: true },
    phoneNumber: { type: String, default: "" },
    hasAuth:     { type: Boolean, default: false },
  },
  { collection: "account_infos" }
);

// ── User Info ──────────────────────────────────────────────────────────────────
const UserInfoSchema = new Schema(
  {
    userId:        { type: Number, required: true, unique: true },
    username:      { type: String, default: "" },
    firstName:     { type: String, default: "" },
    isPremium:     { type: Boolean, default: false },
    premiumExpiry: { type: Date,    default: null },
    isBanned:      { type: Boolean, default: false },
    isAdmin:       { type: Boolean, default: false },
    joinedAt:      { type: Date,    default: Date.now },
    // ── Referral System ──────────────────────────────────────────────────────
    referralCode:  { type: String, default: null, sparse: true },
    referredBy:    { type: Number, default: null },
    referralCount: { type: Number, default: 0 },
  },
  { collection: "users" }
);
UserInfoSchema.index({ referralCode: 1 }, { sparse: true });

// ── Redeem Key (multi-use) ────────────────────────────────────────────────────
// maxUses  = how many different users can redeem this key (owner sets)
// usedCount = how many have redeemed so far
// usedBy   = array of userIds who redeemed
// isExpired = owner manually expired the key
const RedeemKeySchema = new Schema(
  {
    key:             { type: String, required: true, unique: true },
    durationSeconds: { type: Number, default: null },   // null = permanent
    durationLabel:   { type: String, required: true },
    maxUses:         { type: Number, default: 1 },      // 1 = single-use
    usedCount:       { type: Number, default: 0 },
    usedBy:          { type: [Number], default: [] },   // userIds that redeemed
    isExpired:       { type: Boolean, default: false }, // manual expiry by owner
    createdBy:       { type: Number, required: true },
    createdAt:       { type: Date,   default: Date.now },
  },
  { collection: "redeem_keys" }
);

// ── Bot Settings (singleton) ──────────────────────────────────────────────────
// mode: "free"    → everyone can use the bot
// mode: "premium" → only premium users can use the bot
const BotSettingsSchema = new Schema(
  {
    key:   { type: String, default: "global", unique: true },
    mode:  { type: String, default: "free", enum: ["free", "premium"] },
  },
  { collection: "bot_settings" }
);

const AuthState    = mongoose.model("AuthState",    AuthStateSchema);
const AccountInfo  = mongoose.model("AccountInfo",  AccountInfoSchema);
const UserInfo     = mongoose.model("UserInfo",     UserInfoSchema);
const RedeemKey    = mongoose.model("RedeemKey",    RedeemKeySchema);
const BotSettings  = mongoose.model("BotSettings",  BotSettingsSchema);

module.exports = { AuthState, AccountInfo, UserInfo, RedeemKey, BotSettings };
