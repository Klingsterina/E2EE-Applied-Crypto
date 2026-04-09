const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("join-btn");
const statusText = document.getElementById("status");

let currentRoom = null;
let hasJoined = false;

function setStatus(message) {
  if (!statusText) return;
  statusText.textContent = message;
}

joinBtn.addEventListener("click", () => {
  const username = usernameInput?.value.trim();
  const roomId = roomInput?.value.trim();

  if (!username || !roomId) {
    console.log("Username and room are required");
    setStatus("Username and room are required.");
    return;
  }

  if (hasJoined && currentRoom === roomId) {
    setStatus("You already joined this room.");
    return;
  }

  if (hasJoined && currentRoom !== roomId) {
    setStatus("You are already in a room.");
    return;
  }

  setStatus("Joining room...");
  socket.emit("join-room", { roomId, username });
});

socket.on("joined-room", async ({ roomId, username }) => {
  try {
    hasJoined = true;
    currentRoom = roomId;

    setStatus("Joined room. Generating ECDH keys...");

    const { publicKey } = await window.e2eeCrypto.generateECDHKeyPair();

    setStatus("ECDH keys ready.");

    console.log("Joined room:", roomId);
    console.log("Username:", username);
    console.log("ECDH key pair generated");

    // task #9:
    socket.emit("public-key", { roomId, username, publicKey });
  } catch (error) {
    console.error("ECDH generation failed:", error);
    setStatus("Failed to generate ECDH keys.");
  }
});

socket.on("user-joined", ({ username }) => {
  console.log(`${username} joined the room`);
  setStatus(`${username} joined the room`);
});

socket.on("user-left", ({ username }) => {
  console.log(`${username} left the room`);
  setStatus(`${username} left the room`);
});

socket.on("room-full", () => {
  console.log("Room is full.");
  setStatus("Room is full.");
});

socket.on("error-message", (msg) => {
  console.log("Error:", msg);
  setStatus("Something went wrong. Please try again.");
});
