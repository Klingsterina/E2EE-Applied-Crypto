const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId || !username) {
      socket.emit("error-message", "roomId and username are required.");
      return;
    }

    const room = io.sockets.adapter.rooms.get(roomId);
    const roomSize = room ? room.size : 0;

    if (socket.data.roomId === roomId) {
      socket.emit("error-message", "Already joined this room.");
      return;
    }

    if (roomSize >= 2 && (!room || !room.has(socket.id))) {
      socket.emit("room-full");
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = username;

    socket.emit("joined-room", {
      roomId,
      username,
      socketId: socket.id,
    });

    socket.to(roomId).emit("user-joined", {
      socketId: socket.id,
      username,
    });

    console.log(`${username} joined room ${roomId}`);
  });

  socket.on("public-key", ({ roomId, username, publicKey }) => {
    if (!roomId || !username || !publicKey) {
      socket.emit(
        "error-message",
        "roomId, username and publicKey are required.",
      );
      return;
    }

    socket.data.roomId = roomId;
    socket.data.username = username;
    socket.data.publicKey = publicKey;

    console.log(`Received public key from ${username} in room ${roomId}`);

    socket.to(roomId).emit("peer-public-key", {
      username,
      publicKey,
    });

    const room = io.sockets.adapter.rooms.get(roomId);

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

  socket.on("disconnect", () => {
    const { roomId, username } = socket.data || {};

    if (roomId) {
      socket.to(roomId).emit("user-left", {
        socketId: socket.id,
        username,
      });
    }

    console.log(`${username} left room ${roomId}`);
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
