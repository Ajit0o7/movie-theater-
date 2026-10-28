import { storage } from './util.js';

const form = document.getElementById('landing-form');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const errorEl = document.getElementById('landing-error');

nameInput.value = storage.get('cinema.name', '');

function saveName() {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    errorEl.textContent = 'Enter your name first.';
    return false;
  }
  storage.set('cinema.name', name);
  return true;
}

export function parseRoomId(value) {
  const text = value.trim();
  const match = text.match(/\/room\/([a-z0-9-]{3,40})/i) || text.match(/^([a-z0-9-]{3,40})$/i);
  return match ? match[1].toLowerCase() : null;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.textContent = '';
  if (!saveName()) return;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { url } = await res.json();
    location.href = url;
  } catch {
    errorEl.textContent = 'Could not create a room. Is the server running?';
  }
});

function join() {
  errorEl.textContent = '';
  const id = parseRoomId(roomInput.value);
  if (!id) {
    errorEl.textContent = 'That doesn’t look like a room code or invite link.';
    roomInput.focus();
    return;
  }
  if (!saveName()) return;
  location.href = `/room/${id}`;
}

joinBtn.addEventListener('click', join);
roomInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    join();
  }
});
