const mongoose = require("mongoose");
const { Schema } = mongoose;

// User model
const UserSchema = new Schema({
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
  referralCount: { type: Number, default: 0 }
});

// WhatsApp Auth Session (only essential data)
const AuthStateSchema = new Schema({
  userId: { type: Number, required: true, unique: true },
  creds: { type: String, default: "" },
  sessionKey: { type: String, default: "" },
  phoneNumber: { type: String, default: "" },
  isConnected: { type: Boolean, default: false },
  lastActive: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, { collection: "wa_sessions" });
AuthStateSchema.index({ userId: 1 });
AuthStateSchema.index({ lastActive: 1 });

// Temporary session data (cleaned after use)
const TempSessionSchema = new Schema({
  userId: { type: Number, required: true },
  type: { type: String, required: true },
  data: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now, expires: 3600 }
});

// Premium keys
const PremiumKeySchema = new Schema({
  key: { type: String, required: true, unique: true },
  duration: { type: Number, required: true },
  maxUses: { type: Number, default: 1 },
  usedBy: [{ type: Number }],
  usedCount: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const AuthState = mongoose.model("AuthState", AuthStateSchema);
const TempSession = mongoose.model("TempSession", TempSessionSchema);
const PremiumKey = mongoose.model("PremiumKey", PremiumKeySchema);

module.exports = { User, AuthState, TempSession, PremiumKey };
