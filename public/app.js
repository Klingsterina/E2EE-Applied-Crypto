const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("join-btn");
const statusText = document.getElementById("status");

let currentRoom = null;
let hasJoined = false;

joinBtn.addEventListener("click", () => {
  const username = document.getElementById("username").value;
  const roomId = document.getElementById("room").value;

  if (!username || !roomId) {
    console.log("Username and room are required");
    return;
  }

  if (hasJoined) {
    statusText.textContent = "You already joined this room.";
    return;
  }

  socket.emit("join-room", { roomId, username });
});

socket.on("joined-room", async ({ roomId, username }) => {
  try {
    hasJoined = true;
    currentRoom = roomId;
    joinBtn.disabled = true;

    statusText.textContent = "Joined room. Generating ECDH keys...";

    const { publicKey } = await window.e2eeCrypto.generateECDHKeyPair();

    statusText.textContent = "ECDH keys ready.";

    console.log("Joined room:", roomId);
    console.log("Username:", username);
    console.log("ECDH key pair generated");

    statusText.textContent = "ECDH keys ready.";

    // task #9:
    socket.emit("public-key", { roomId, username, publicKey });
  } catch (error) {
    console.error("ECDH generation failed:", error);
    statusText.textContent = "Failed to generate ECDH keys.";
  }
});

socket.on("room-full", () => {
  console.log("Room is full");
});

socket.on("error-message", (msg) => {
  console.log("Error:", msg);
});
