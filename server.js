const path = require("path");
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 25000,
  pingTimeout: 120000,
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const ROOM_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;
const issuedRooms = new Map();
const EMPTY_ROOM_TTL_MS = 30_000;
const pendingRoomDeletions = new Map();

const JOIN_WINDOW_MS = 60_000;
const MAX_JOIN_ATTEMPTS = 10;
const joinAttempts = new Map();

function generateRoomId() {
  return crypto.randomBytes(16).toString("base64url");
}

function getClientKey(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }

  return socket.handshake.address || socket.id;
}

function isJoinRateLimited(socket) {
  const key = getClientKey(socket);
  const now = Date.now();

  const attempts = joinAttempts.get(key) || [];
  const recentAttempts = attempts.filter((ts) => now - ts < JOIN_WINDOW_MS);

  recentAttempts.push(now);
  joinAttempts.set(key, recentAttempts);

  return recentAttempts.length > MAX_JOIN_ATTEMPTS;
}

function cancelPendingRoomDeletion(roomId) {
  const timeoutId = pendingRoomDeletions.get(roomId);

  if (timeoutId) {
    clearTimeout(timeoutId);
    pendingRoomDeletions.delete(roomId);
  }
}

function scheduleRoomDeletionIfEmpty(roomId) {
  cancelPendingRoomDeletion(roomId);

  const timeoutId = setTimeout(() => {
    const room = io.sockets.adapter.rooms.get(roomId);

    if (!room || room.size === 0) {
      issuedRooms.delete(roomId);
    }

    pendingRoomDeletions.delete(roomId);
  }, EMPTY_ROOM_TTL_MS);

  pendingRoomDeletions.set(roomId, timeoutId);
}

io.on("connection", (socket) => {
  socket.on("create-room", () => {
    let roomId;

    do {
      roomId = generateRoomId();
    } while (issuedRooms.has(roomId));

    issuedRooms.set(roomId, {
      createdAt: Date.now(),
    });

    socket.emit("room-created", { roomId });
  });

  socket.on("validate-room", ({ roomId } = {}, callback) => {
    if (typeof callback !== "function") {
      return;
    }

    if (typeof roomId !== "string" || !roomId.trim()) {
      callback({ ok: false, message: "Room code is required." });
      return;
    }

    const normalizedRoomId = roomId.trim();

    if (!ROOM_ID_REGEX.test(normalizedRoomId)) {
      callback({ ok: false, message: "Invalid room code format." });
      return;
    }

    if (!issuedRooms.has(normalizedRoomId)) {
      callback({ ok: false, message: "Invalid room code." });
      return;
    }

    const room = io.sockets.adapter.rooms.get(normalizedRoomId);
    const roomSize = room ? room.size : 0;

    if (roomSize >= 2) {
      callback({ ok: false, message: "Room is full." });
      return;
    }

    callback({ ok: true });
  });

  socket.on("join-room", ({ roomId, username } = {}) => {
    if (isJoinRateLimited(socket)) {
      socket.emit("error-message", "Too many join attempts. Try again later.");
      return;
    }

    if (
      typeof roomId !== "string" ||
      typeof username !== "string" ||
      !roomId.trim() ||
      !username.trim()
    ) {
      socket.emit("error-message", "roomId and username are required.");
      return;
    }

    const normalizedRoomId = roomId.trim();
    const normalizedUsername = username.trim();

    if (!ROOM_ID_REGEX.test(normalizedRoomId)) {
      socket.emit("error-message", "Invalid room ID.");
      return;
    }

    if (!issuedRooms.has(normalizedRoomId)) {
      socket.emit("error-message", "Invalid room ID.");
      return;
    }

    if (socket.data.roomId === normalizedRoomId) {
      socket.emit("error-message", "Already joined this room.");
      return;
    }

    const room = io.sockets.adapter.rooms.get(normalizedRoomId);
    const roomSize = room ? room.size : 0;

    if (roomSize >= 2 && (!room || !room.has(socket.id))) {
      socket.emit("room-full");
      return;
    }

    cancelPendingRoomDeletion(normalizedRoomId);

    socket.join(normalizedRoomId);
    socket.data.roomId = normalizedRoomId;
    socket.data.username = normalizedUsername;
    socket.data.publicKey = null;

    socket.emit("joined-room", {
      roomId: normalizedRoomId,
      username: normalizedUsername,
      socketId: socket.id,
    });

    socket.to(normalizedRoomId).emit("user-joined", {
      socketId: socket.id,
      username: normalizedUsername,
    });
  });

  socket.on("public-key", ({ roomId, publicKey } = {}) => {
    if (
      typeof roomId !== "string" ||
      typeof publicKey !== "string" ||
      !roomId.trim() ||
      !publicKey.trim()
    ) {
      socket.emit("error-message", "roomId and publicKey are required.");
      return;
    }

    const normalizedRoomId = roomId.trim();
    const normalizedPublicKey = publicKey.trim();

    if (socket.data.roomId !== normalizedRoomId) {
      socket.emit("error-message", "You are not in this room.");
      return;
    }

    socket.data.publicKey = normalizedPublicKey;

    socket.to(normalizedRoomId).emit("peer-public-key", {
      username: socket.data.username,
      publicKey: normalizedPublicKey,
    });

    const room = io.sockets.adapter.rooms.get(normalizedRoomId);

    if (!room) return;

    for (const peerSocketId of room) {
      if (peerSocketId === socket.id) continue;

      const peerSocket = io.sockets.sockets.get(peerSocketId);

      if (peerSocket?.data?.publicKey) {
        socket.emit("peer-public-key", {
          username: peerSocket.data.username,
          publicKey: peerSocket.data.publicKey,
        });
      }
    }
  });

  socket.on("send-encrypted-message", ({ roomId, ciphertext, iv } = {}) => {
    if (
      typeof roomId !== "string" ||
      typeof ciphertext !== "string" ||
      typeof iv !== "string" ||
      !roomId.trim() ||
      !ciphertext.trim() ||
      !iv.trim()
    ) {
      socket.emit("error-message", "roomId, ciphertext and iv are required.");
      return;
    }

    const normalizedRoomId = roomId.trim();

    if (socket.data.roomId !== normalizedRoomId) {
      socket.emit("error-message", "You are not in this room.");
      return;
    }

    socket.to(normalizedRoomId).emit("receive-encrypted-message", {
      username: socket.data.username,
      ciphertext: ciphertext.trim(),
      iv: iv.trim(),
    });
  });

  socket.on("disconnecting", () => {
    const { roomId, username } = socket.data || {};

    if (roomId) {
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        username,
      });
    }
  });

  socket.on("disconnect", () => {
    const { roomId } = socket.data || {};

    if (roomId) {
      scheduleRoomDeletionIfEmpty(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
