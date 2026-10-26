// Translucent slide-over chat drawer + participant list.

import { $, h, hueFor, initials } from './util.js';

export class ChatDrawer {
  constructor({ socket, selfId }) {
    this.socket = socket;
    this.selfId = selfId;
    this.drawer = $('#chat-drawer');
    this.list = $('#messages');
    this.people = $('#people-list');
    this.input = $('#chat-input');
    this.badge = $('#chat-badge');
    this.unread = 0;
    this.open = this.drawer.classList.contains('open'); // survives a reconnect

    // DOM listeners must be removed in destroy(): a new ChatDrawer is built on every
    // (re)connect, and a leftover listener would send each message once more per reconnect.
    this.composer = $('#composer');
    this.onSubmit = (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (!text) return;
      socket.emit('chat:send', { text });
      this.input.value = '';
    };
    this.composer.addEventListener('submit', this.onSubmit);

    this.onMessage = (m) => this.append(m, true);
    socket.on('chat:message', this.onMessage);
  }

  load(history) {
    this.list.replaceChildren();
    for (const m of history) this.append(m, false);
  }

  append(message, notify) {
    const mine = message.authorId === this.selfId;
    const time = new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const item = h('li', { class: `msg${mine ? ' mine' : ''}`, style: `--hue:${hueFor(message.name)}` }, [
      h('div', { class: 'msg-meta' }, [h('span', { class: 'msg-name', text: mine ? 'You' : message.name }), h('time', { text: time })]),
      h('p', { class: 'msg-text', text: message.text }),
    ]);
    this.list.append(item);
    while (this.list.children.length > 200) this.list.firstElementChild.remove();
    this.list.scrollTop = this.list.scrollHeight;
    if (notify && !mine && !this.open) {
      this.unread++;
      this.badge.textContent = this.unread > 9 ? '9+' : String(this.unread);
      this.badge.hidden = false;
      this.dispatchPeek(message);
    }
  }

  /** Brief preview so messages aren't missed while the drawer is closed. */
  dispatchPeek(message) {
    document.dispatchEvent(new CustomEvent('chat:peek', { detail: message }));
  }

  renderPeople(participants) {
    this.people.replaceChildren(
      ...participants.map((p) =>
        h('li', { class: 'person', style: `--hue:${hueFor(p.name)}`, title: p.name }, [
          h('span', { class: 'person-avatar', text: initials(p.name) }),
          h('span', { class: 'person-name', text: p.id === this.selfId ? `${p.name} (you)` : p.name }),
        ]),
      ),
    );
  }

  toggle(force) {
    this.open = force ?? !this.open;
    this.drawer.classList.toggle('open', this.open);
    this.drawer.inert = !this.open;
    document.body.classList.toggle('chat-open', this.open);
    if (this.open) {
      this.unread = 0;
      this.badge.hidden = true;
      this.list.scrollTop = this.list.scrollHeight;
      setTimeout(() => this.input.focus({ preventScroll: true }), 150);
    }
  }

  destroy() {
    this.socket.off('chat:message', this.onMessage);
    this.composer.removeEventListener('submit', this.onSubmit);
  }
}
