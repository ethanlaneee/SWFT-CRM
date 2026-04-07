// ════════════════════════════════════════════════
// SWFT Mobile — Messages Page
// ════════════════════════════════════════════════

import { API } from '../api.js';

export async function renderMessages(container) {
  container.innerHTML = `
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input type="text" placeholder="Search conversations..." id="msg-search"/>
    </div>
    <div id="msg-list"><div class="spinner"></div></div>`;

  try {
    const data = await API.messages.list();
    const messages = data.conversations || data.messages || data || [];

    // Group by phone number / contact
    const grouped = {};
    (Array.isArray(messages) ? messages : []).forEach(m => {
      const key = m.phone || m.to || m.from || 'unknown';
      if (!grouped[key]) {
        grouped[key] = {
          phone: key,
          name: m.customerName || m.name || key,
          messages: [],
          lastMessage: null,
          lastTime: null,
          unread: false,
        };
      }
      grouped[key].messages.push(m);
      const time = m.createdAt?.seconds ? m.createdAt.seconds * 1000 : new Date(m.createdAt || m.date).getTime();
      if (!grouped[key].lastTime || time > grouped[key].lastTime) {
        grouped[key].lastTime = time;
        grouped[key].lastMessage = m.body || m.message || m.text || '';
        if (m.direction === 'inbound' && !m.read) grouped[key].unread = true;
      }
    });

    const convos = Object.values(grouped).sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    const listEl = document.getElementById('msg-list');

    if (convos.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          ${App.icons.messages}
          <h3>No Messages</h3>
          <p>Conversations with your customers will appear here</p>
        </div>`;
      return;
    }

    listEl.innerHTML = `<div class="list-card">${convos.map(c => `
      <div class="convo-item" onclick="App.navigate('conversation', { id: '${c.phone}', phone: '${c.phone}', name: '${(c.name || '').replace(/'/g, "\\'")}' })">
        <div class="convo-avatar">${App.initials(c.name)}</div>
        <div class="convo-body">
          <div class="convo-name">${c.name}</div>
          <div class="convo-preview">${c.lastMessage || 'No messages'}</div>
        </div>
        <div class="convo-right">
          <span class="convo-time">${App.timeAgo({ seconds: c.lastTime / 1000 })}</span>
          ${c.unread ? '<div class="convo-unread"></div>' : ''}
        </div>
      </div>`).join('')}</div>`;

    // Search
    document.getElementById('msg-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.convo-item').forEach(item => {
        const name = item.querySelector('.convo-name')?.textContent.toLowerCase() || '';
        item.style.display = name.includes(q) ? '' : 'none';
      });
    });

  } catch (e) {
    document.getElementById('msg-list').innerHTML = '<div class="empty-state"><p>Could not load messages</p></div>';
  }
}

export async function renderConversation(container, id, phone) {
  // Hide tab bar, show message input
  container.innerHTML = `
    <div id="convo-messages" class="msg-list" style="padding-bottom: 80px;">
      <div class="spinner"></div>
    </div>
    <div class="msg-input-bar">
      <input type="text" class="msg-input" id="msg-input" placeholder="Type a message..."/>
      <button class="msg-send-btn" id="msg-send-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>`;

  // Load messages for this conversation
  try {
    const data = await API.messages.list();
    const messages = data.conversations || data.messages || data || [];
    const convoMsgs = (Array.isArray(messages) ? messages : [])
      .filter(m => (m.phone || m.to || m.from) === phone)
      .sort((a, b) => {
        const ta = a.createdAt?.seconds || new Date(a.createdAt || a.date).getTime() / 1000;
        const tb = b.createdAt?.seconds || new Date(b.createdAt || b.date).getTime() / 1000;
        return ta - tb;
      });

    const msgsEl = document.getElementById('convo-messages');
    if (convoMsgs.length === 0) {
      msgsEl.innerHTML = '<div class="empty-state" style="padding: 40px;"><p>No messages in this conversation</p></div>';
    } else {
      msgsEl.innerHTML = convoMsgs.map(m => {
        const isOut = m.direction === 'outbound' || m.direction === 'outbound-api';
        const time = m.createdAt?.seconds ? new Date(m.createdAt.seconds * 1000) : new Date(m.createdAt || m.date);
        return `
          <div class="msg-bubble ${isOut ? 'msg-out' : 'msg-in'}">
            ${m.body || m.message || m.text || ''}
            <div class="msg-time" style="color: ${isOut ? 'rgba(0,0,0,0.5)' : 'var(--gray2)'}">
              ${time.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </div>
          </div>`;
      }).join('');

      // Scroll to bottom
      msgsEl.scrollTop = msgsEl.scrollHeight;
    }
  } catch (e) {
    document.getElementById('convo-messages').innerHTML = '<div class="empty-state"><p>Could not load messages</p></div>';
  }

  // Send message
  const sendBtn = document.getElementById('msg-send-btn');
  const input = document.getElementById('msg-input');

  const sendMessage = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';

    // Optimistically add message to UI
    const msgsEl = document.getElementById('convo-messages');
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble msg-out';
    bubble.innerHTML = `${text}<div class="msg-time" style="color: rgba(0,0,0,0.5);">Sending...</div>`;
    msgsEl.appendChild(bubble);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    try {
      await API.messages.send({ to: phone, body: text });
      bubble.querySelector('.msg-time').textContent = 'Sent';
    } catch (e) {
      bubble.querySelector('.msg-time').textContent = 'Failed to send';
      bubble.style.opacity = '0.5';
    }
  };

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
}
