/**
 * Minimal WhatsApp Manager - Per user, on-demand connections
 */
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const pino = require("pino");
const { useMongoAuthState, clearUserAuth, hasAuth } = require("./mongoAuthState");
const { AuthState } = require("./models");

const logger = pino({ level: "silent" });
const activeSockets = new Map();

async function getUserStatus(userId) {
  const conn = activeSockets.get(userId);
  if (conn && conn.status === "connected") return "connected";
  const auth = await AuthState.findOne({ userId });
  return auth && auth.isConnected ? "connecting" : "disconnected";
}

async function getUserPhone(userId) {
  const auth = await AuthState.findOne({ userId });
  return auth?.phoneNumber || "";
}

async function connectUser(userId, phoneNumber) {
  // Close existing connection
  const existing = activeSockets.get(userId);
  if (existing?.socket) {
    try { existing.socket.end(undefined); } catch(e) {}
    activeSockets.delete(userId);
  }

  const { state, saveCreds } = await useMongoAuthState(userId);
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ["Chrome", "", ""],
    syncFullHistory: false,
    downloadHistory: false,
    fireInitQueries: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 30000,
    defaultQueryTimeoutMs: 30000
  });

  activeSockets.set(userId, { socket: sock, status: "connecting", phoneNumber: phoneNumber?.replace(/\D/g, "") });
  sock.ev.on("creds.update", saveCreds);
  
  let pairingRequested = false;
  
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr && !pairingRequested && phoneNumber) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ""));
        const formatted = code.match(/.{1,4}/g)?.join("-") || code;
        const cb = global.userCallbacks?.get(userId)?.onPairingCode;
        if (cb) cb(formatted);
      } catch(e) { console.error("Pairing error:", e.message); }
    }
    
    if (connection === "open") {
      await AuthState.findOneAndUpdate(
        { userId },
        { userId, isConnected: true, phoneNumber: phoneNumber?.replace(/\D/g, ""), lastActive: new Date() },
        { upsert: true }
      );
      activeSockets.set(userId, { socket: sock, status: "connected", phoneNumber: phoneNumber?.replace(/\D/g, "") });
      const cb = global.userCallbacks?.get(userId)?.onReady;
      if (cb) cb();
    }
    
    if (connection === "close") {
      const isLoggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      if (isLoggedOut) {
        await clearUserAuth(userId);
        await AuthState.findOneAndUpdate({ userId }, { isConnected: false, phoneNumber: "" });
      }
      activeSockets.delete(userId);
      const cb = global.userCallbacks?.get(userId)?.onDisconnected;
      if (cb) cb(isLoggedOut);
    }
  });
  
  return sock;
}

async function disconnectUser(userId) {
  const conn = activeSockets.get(userId);
  if (conn?.socket) {
    try { conn.socket.end(undefined); } catch(e) {}
  }
  activeSockets.delete(userId);
  await clearUserAuth(userId);
  await AuthState.findOneAndUpdate({ userId }, { isConnected: false, phoneNumber: "" });
}

function getSocket(userId) {
  const conn = activeSockets.get(userId);
  if (!conn || conn.status !== "connected") return null;
  return conn.socket;
}

// Group operations
async function getAllGroups(userId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("WhatsApp not connected!");
  const groups = await sock.groupFetchAllParticipating();
  return Object.entries(groups).map(([id, g]) => ({
    id, name: g.subject || id,
    participantCount: g.participants?.length ?? 0,
    participants: g.participants ?? []
  }));
}

async function getGroupInviteLink(userId, groupId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  const code = await sock.groupInviteCode(groupId);
  return `https://chat.whatsapp.com/${code}`;
}

async function leaveGroup(userId, groupId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.groupLeave(groupId);
}

async function renameGroup(userId, groupId, newName) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.groupUpdateSubject(groupId, newName);
}

async function getGroupMembers(userId, groupId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  const meta = await sock.groupMetadata(groupId);
  return (meta.participants || []).map(p => ({
    id: p.id,
    number: p.id.split("@")[0],
    admin: p.admin === "admin" || p.admin === "superadmin"
  }));
}

async function getGroupPending(userId, groupId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  return await sock.groupRequestParticipantsList(groupId) || [];
}

async function approvePending(userId, groupId, jids) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.groupRequestParticipantsUpdate(groupId, jids, "approve");
}

async function setApprovalMode(userId, groupId, enable) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.groupJoinApprovalMode(groupId, enable ? "on" : "off");
}

async function getApprovalMode(userId, groupId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  const meta = await sock.groupMetadata(groupId);
  return meta.joinApprovalMode === "on";
}

async function makeAdmin(userId, groupId, phones) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  let promoted = 0;
  for (const phone of phones) {
    const digits = phone.replace(/\D/g, "");
    try {
      const results = await sock.onWhatsApp(digits);
      const found = results?.find(r => r.exists && r.jid);
      if (found) {
        await sock.groupParticipantsUpdate(groupId, [found.jid], "promote");
        promoted++;
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 800));
  }
  return promoted;
}

async function demoteAdmin(userId, groupId, phones) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  let demoted = 0;
  for (const phone of phones) {
    const digits = phone.replace(/\D/g, "");
    try {
      const results = await sock.onWhatsApp(digits);
      const found = results?.find(r => r.exists && r.jid);
      if (found) {
        await sock.groupParticipantsUpdate(groupId, [found.jid], "demote");
        demoted++;
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 600));
  }
  return demoted;
}

async function joinGroupViaLink(userId, code) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  return await sock.groupAcceptInvite(code);
}

async function getGroupInfo(userId, code) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  return await sock.groupGetInviteInfo(code);
}

async function createGroup(userId, name, jids) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  return await sock.groupCreate(name, jids);
}

async function setGroupDesc(userId, groupId, desc) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.groupUpdateDescription(groupId, desc);
}

async function setGroupPhoto(userId, groupId, buffer) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.updateProfilePicture(groupId, buffer);
}

async function setDisappearing(userId, groupId, seconds) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.groupToggleEphemeral(groupId, seconds);
}

async function addMembers(userId, groupId, phones) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  const jids = phones.map(p => `${p.replace(/\D/g, "")}@s.whatsapp.net`);
  let added = 0;
  for (const jid of jids) {
    try {
      await sock.groupParticipantsUpdate(groupId, [jid], "add");
      added++;
    } catch(e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return added;
}

async function removeMembers(userId, groupId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  const meta = await sock.groupMetadata(groupId);
  const myJid = sock.user?.id;
  const toRemove = meta.participants.filter(p => p.id !== myJid && p.admin !== "admin");
  let removed = 0;
  for (const p of toRemove) {
    try {
      await sock.groupParticipantsUpdate(groupId, [p.id], "remove");
      removed++;
    } catch(e) {}
    await new Promise(r => setTimeout(r, 1200));
  }
  return removed;
}

async function resetInviteLink(userId, groupId) {
  const sock = getSocket(userId);
  if (!sock) throw new Error("Not connected!");
  await sock.groupRevokeInvite(groupId);
  const code = await sock.groupInviteCode(groupId);
  return `https://chat.whatsapp.com/${code}`;
}

module.exports = {
  connectUser, disconnectUser, getUserStatus, getUserPhone, getSocket,
  getAllGroups, getGroupInviteLink, leaveGroup, renameGroup,
  getGroupMembers, getGroupPending, approvePending,
  setApprovalMode, getApprovalMode, makeAdmin, demoteAdmin,
  joinGroupViaLink, getGroupInfo, createGroup, setGroupDesc,
  setGroupPhoto, setDisappearing, addMembers, removeMembers, resetInviteLink
};
