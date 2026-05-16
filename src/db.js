const mongoose = require("mongoose");

let connected = false;

async function connectDB() {
  if (connected) return;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ MONGODB_URI not set!");
  
  await mongoose.connect(uri, { 
    serverSelectionTimeoutMS: 15000,
    maxPoolSize: 10,
    minPoolSize: 2
  });
  connected = true;
  console.log("✅ MongoDB connected");
  
  // Auto cleanup old temp data
  setInterval(async () => {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await mongoose.connection.db.collection("temp_sessions").deleteMany({ createdAt: { $lt: oneDayAgo } });
    } catch(e) {}
  }, 3600000);
}

module.exports = { connectDB };
