const usernameInput = document.getElementById("username");
const roomInput = document.getElementById("room");
const joinBtn = document.getElementById("join-btn");
const statusText = document.getElementById("status");

function setStatus(message) {
  if (!statusText) return;
  statusText.textContent = message;
}

joinBtn?.addEventListener("click", () => {
  const username = usernameInput?.value.trim();
  const roomId = roomInput?.value.trim();

  if (!username || !roomId) {
    setStatus("Username and room are required.");
    return;
  }

  const params = new URLSearchParams({
    username,
    room: roomId,
  });

  window.location.href = `/chat.html?${params.toString()}`;
});
