/**
 * Minimal MongoDB auth state - stores only essential credentials
 */
const { initAuthCreds, BufferJSON, proto, makeCacheableSignalKeyStore } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { AuthState, TempSession } = require("./models");

const logger = pino({ level: "silent" });

async function useMongoAuthState(userId) {
  // Load only creds, no other keys stored
  let creds = null;
  try {
    const doc = await AuthState.findOne({ userId }).lean();
    if (doc && doc.creds) {
      creds = JSON.parse(doc.creds, BufferJSON.reviver);
    }
  } catch(e) {}
  
  if (!creds) creds = initAuthCreds();

  // Minimal key store - only for active session
  const keys = {
    get: async (type, ids) => {
      const result = {};
      for (const id of ids) {
        const key = `${type}__${id}`;
        try {
          const temp = await TempSession.findOne({ userId, type: key }).lean();
          result[id] = temp ? JSON.parse(temp.data, BufferJSON.reviver) : null;
        } catch(e) { result[id] = null; }
      }
      return result;
    },
    set: async (data) => {
      const operations = [];
      for (const category of Object.keys(data)) {
        for (const id of Object.keys(data[category])) {
          const value = data[category][id];
          const key = `${category}__${id}`;
          if (value) {
            operations.push(TempSession.findOneAndUpdate(
              { userId, type: key },
              { userId, type: key, data: JSON.stringify(value, BufferJSON.replacer), createdAt: new Date() },
              { upsert: true }
            ));
          }
        }
      }
      await Promise.all(operations);
    }
  };

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(keys, logger)
    },
    saveCreds: async () => {
      await AuthState.findOneAndUpdate(
        { userId },
        { userId, creds: JSON.stringify(creds, BufferJSON.replacer), lastActive: new Date() },
        { upsert: true }
      );
    }
  };
}

async function clearUserAuth(userId) {
  await AuthState.deleteOne({ userId });
  await TempSession.deleteMany({ userId });
}

async function hasAuth(userId) {
  const doc = await AuthState.findOne({ userId }).lean();
  return !!doc;
}

module.exports = { useMongoAuthState, clearUserAuth, hasAuth };
