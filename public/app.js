
const joinBtn = document.getElementById('join-btn');

joinBtn.addEventListener('click', () => {
  const username = document.getElementById('username').value;
  const roomId = document.getElementById('room').value;

  if (!username || !roomId) {
    console.log('Username and room are required');
    return;
  }

  socket.emit('join-room', { roomId, username });
});

socket.on('joined-room', (data) => {
  console.log('Joined room:', data);
});

socket.on('room-full', () => {
  console.log('Room is full');
});

socket.on('error-message', (msg) => {
  console.log('Error:', msg);
});