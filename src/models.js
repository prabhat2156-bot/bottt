const mongoose = require("mongoose");
const { Schema } = mongoose;

const AuthStateSchema = new Schema(
  {
    accountId: { type: String, required: true },
    type:      { type: String, required: true },
    data:      { type: String, required: true },
  },
  { collection: "auth_states" }
);
AuthStateSchema.index({ accountId: 1, type: 1 }, { unique: true });

const AccountInfoSchema = new Schema(
  {
    userId:      { type: String, required: true, unique: true },
    phoneNumber: { type: String, default: "" },
    hasAuth:     { type: Boolean, default: false },
  },
  { collection: "account_infos" }
);

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
    // ── Referral System ──────────────────────────────
    referralCode:  { type: String, default: null, sparse: true },
    referredBy:    { type: Number, default: null },
    referralCount: { type: Number, default: 0 },
  },
  { collection: "users" }
);
UserInfoSchema.index({ referralCode: 1 }, { sparse: true });

const RedeemKeySchema = new Schema(
  {
    key:             { type: String, required: true, unique: true },
    durationSeconds: { type: Number, default: null },
    durationLabel:   { type: String, required: true },
    createdBy:       { type: Number, required: true },
    isUsed:          { type: Boolean, default: false },
    redeemedBy:      { type: Number, default: null },
    redeemedAt:      { type: Date,   default: null },
    createdAt:       { type: Date,   default: Date.now },
  },
  { collection: "redeem_keys" }
);

const AuthState   = mongoose.model("AuthState",   AuthStateSchema);
const AccountInfo = mongoose.model("AccountInfo", AccountInfoSchema);
const UserInfo    = mongoose.model("UserInfo",    UserInfoSchema);
const RedeemKey   = mongoose.model("RedeemKey",   RedeemKeySchema);

module.exports = { AuthState, AccountInfo, UserInfo, RedeemKey };
