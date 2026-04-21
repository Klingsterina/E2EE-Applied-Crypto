const path = require("path");
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const ROOM_ID_REGEX = /^[A-Za-z0-9_-]{22}$/;
const issuedRooms = new Map();

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

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

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

    console.log(`${normalizedUsername} joined room ${normalizedRoomId}`);
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

    console.log(
      `Received public key from ${socket.data.username} in room ${normalizedRoomId}`,
    );

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

    console.log("[relay] encrypted message forwarded");
  });

  socket.on("disconnect", () => {
    const { roomId, username } = socket.data || {};

    if (roomId) {
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        username,
      });
    }

    if (username && roomId) {
      console.log("[presence] user left room");
    }

    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
