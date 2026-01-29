// Debug logging function (console only)
function debugLog(message) {
    console.log(message);
}

// Real-time Chat functionality - Debug Version
class RealTimeChatApp {
    constructor() {
        this.messagesContainer = document.getElementById('messagesContainer');
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.userCountElement = document.getElementById('userCount');
        this.connectionStatus = document.getElementById('connectionStatus');
        this.username = this.getUsername();
        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.typing = false;
        this.typingTimeout = null;
        this.onlineUsers = new Set();
        this.messageCount = 0;
        this.currentReactionMenu = null; // Track current reaction menu
        this.messageReactions = new Map(); // Store reactions state for each message

        // Available reactions
        this.availableReactions = ['👍', '❤️', '😂', '😮', '😢', '😡', '👏', '😒', '💀'];

        // Presence toasts container
        this.presenceToasts = null;

        debugLog('Initializing chat app...');
        this.initializeEventListeners();
        this.initializeSocket();
    }

    getUsername() {
        // Try to get saved nickname from localStorage first
        const savedNickname = localStorage.getItem('nickname') || localStorage.getItem('userNickname');
        if (savedNickname && savedNickname.trim()) {
            const username = savedNickname.trim();
            debugLog(`Using saved username: ${username}`);
            return username;
        }

        // Fallback to generated username
        const randomNum = Math.floor(Math.random() * 10000);
        const username = `User${randomNum}`;
        debugLog(`Generated username: ${username}`);
        return username;
    }

    initializeSocket() {
        debugLog('Attempting to initialize socket...');

        // Check if Socket.IO is available
        if (typeof io === 'undefined') {
            debugLog('ERROR: Socket.IO not loaded! Running in local mode.');
            this.fallbackToLocalMode();
            return;
        }

        try {
            // Determine environment and connection URL
            let connectionUrl;

            // Check if running locally (localhost or 127.0.0.1)
            const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

            if (isLocal && window.location.port !== '3000') {
                // If local but not on port 3000 (e.g. Live Server on 5500), connect to backend port
                debugLog('🔧 Detected local development on different port, connecting to localhost:3000');
                connectionUrl = 'http://localhost:3000';
            } else {
                // Production or same-origin
                connectionUrl = undefined; // Let Socket.IO determine automatically
            }

            // Initialize Socket.IO connection
            this.socket = io(connectionUrl);

            // Connection successful
            this.socket.on('connect', () => {
                debugLog('✅ Connected to server');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.updateConnectionStatus(`Connected as ${this.username} 🟢`);

                // Add current user to online users set
                this.onlineUsers.add(this.username);
                this.updateUserCount(this.onlineUsers.size);

                // Join chat with username
                debugLog(`Joining chat as: ${this.username}`);
                this.socket.emit('user joined', {
                    username: this.username,
                    timestamp: new Date()
                });
            });

            // Handle incoming messages
            this.socket.on('chat message', (data) => {
                debugLog(`📩 Received message from ${data.username}: ${data.message}`);
                this.addMessage(data.username, data.message, data.username === this.username, data.timestamp, data.id, data.reactions);
            });

            // Handle user join notifications
            this.socket.on('user joined', (data) => {
                debugLog(`👋 User joined: ${data.username}`);
                if (data && data.username) {
                    this.showPresenceToast('join', data.username);
                }
                this.onlineUsers.add(data.username);
                this.updateUserCount(this.onlineUsers.size);

                // Refresh the modal if it's currently open
                this.refreshOnlineUsersList();
            });

            // Handle user leave notifications
            this.socket.on('user left', (data) => {
                debugLog(`👋 User left: ${data.username}`);
                if (data && data.username) {
                    this.showPresenceToast('leave', data.username);
                }
                this.onlineUsers.delete(data.username);
                this.updateUserCount(this.onlineUsers.size);

                // Refresh the modal if it's currently open
                this.refreshOnlineUsersList();
            });

            // Handle user count updates
            this.socket.on('user count', (count) => {
                debugLog(`👥 User count updated: ${count}`);
                this.updateUserCount(count);
            });

            // Handle online users list updates
            this.socket.on('online users', (users) => {
                debugLog(`👥 Received online users list: ${users.length} users`);
                this.onlineUsers.clear();
                users.forEach(username => {
                    this.onlineUsers.add(username);
                });
                this.updateUserCount(this.onlineUsers.size);

                // Refresh the modal if it's currently open
                this.refreshOnlineUsersList();
            });

            // Handle typing indicators
            this.socket.on('user typing', (data) => {
                if (data.username !== this.username) {
                    this.showTypingIndicator(data.username);
                }
            });

            this.socket.on('user stop typing', (data) => {
                if (data.username !== this.username) {
                    this.hideTypingIndicator(data.username);
                }
            });

            // Handle username change notifications
            this.socket.on('username changed', (data) => {
                debugLog(`🔄 Username changed from ${data.oldUsername} to ${data.newUsername}`);
                this.username = data.newUsername;
                this.updateConnectionStatus(`Connected as ${this.username} 🟢`);
                this.addSystemMessage(`${data.oldUsername} is now ${data.newUsername}`, new Date().toISOString());
            });

            // Handle reaction updates
            this.socket.on('message reaction', (data) => {
                debugLog(`😀 Reaction received: ${data.reaction} on message ${data.messageId}`);
                this.updateMessageReactions(data.messageId, data.reaction, data.username, data.action);
            });

            // Receive recent messages (last 24h)
            this.socket.on('recent messages', (messages) => {
                try {
                    debugLog(`🕒 Received recent messages: ${Array.isArray(messages) ? messages.length : 0}`);
                    // Reset UI and local reaction state
                    this.messagesContainer.innerHTML = '';
                    this.messageReactions.clear();
                    if (Array.isArray(messages)) {
                        messages.forEach((m) => {
                            if (!m || !m.id) return;
                            this.addMessage(m.username, m.message, m.username === this.username, m.timestamp, m.id, m.reactions || {});
                        });
                    }
                } catch (e) {
                    debugLog(`⚠ Error rendering recent messages: ${e.message}`);
                }
            });

            // Handle server-driven deletions for expired messages
            this.socket.on('message deleted', (ids) => {
                try {
                    if (!Array.isArray(ids) || ids.length === 0) return;
                    debugLog(`🗑️ Deleting ${ids.length} expired messages`);
                    ids.forEach((id) => {
                        const messageElement = document.querySelector(`[data-message-id="${String(id)}"]`);
                        if (messageElement && messageElement.parentNode) {
                            messageElement.parentNode.removeChild(messageElement);
                        }
                        // Drop local reaction state
                        this.messageReactions.delete(String(id));
                    });
                } catch (e) {
                    debugLog(`⚠ Error deleting messages: ${e.message}`);
                }
            });

            // Handle errors
            this.socket.on('error', (errorData) => {
                debugLog(`⚠ Server error: ${errorData.message}`);
                this.showError(errorData.message);
            });

            // Handle connection errors
            this.socket.on('connect_error', (error) => {
                debugLog(`⚠ Connection error: ${error.message}`);
                this.handleConnectionError();
            });

            // Handle disconnection
            this.socket.on('disconnect', (reason) => {
                debugLog(`🔴 Disconnected: ${reason}`);
                this.isConnected = false;
                this.updateConnectionStatus('Disconnected 🔴 - Trying to reconnect...');

                if (reason === 'io server disconnect') {
                    // Server disconnected, try to reconnect
                    this.socket.connect();
                }
            });

        } catch (error) {
            debugLog(`⚠ Socket.IO initialization failed: ${error.message}`);
            this.fallbackToLocalMode();
        }
    }

    fallbackToLocalMode() {
        debugLog('🔄 Running in local-only mode');
        this.isConnected = false;
        this.updateConnectionStatus(`Local mode - ${this.username} 💾`);

        // Add current user to online users set for local mode
        this.onlineUsers.clear();
        this.onlineUsers.add(this.username);
        this.updateUserCount(this.onlineUsers.size);

        this.addSystemMessage('Running in local mode - messages will only be visible to you');
    }

    handleConnectionError() {
        this.isConnected = false;
        this.reconnectAttempts++;

        if (this.reconnectAttempts <= this.maxReconnectAttempts) {
            debugLog(`🔄 Retrying connection (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            this.updateConnectionStatus(`Connection failed - Retrying (${this.reconnectAttempts}/${this.maxReconnectAttempts}) 🔄`);
            setTimeout(() => {
                if (this.socket) {
                    this.socket.connect();
                }
            }, 2000 * this.reconnectAttempts);
        } else {
            debugLog('⚠ Max reconnection attempts reached, switching to local mode');
            this.updateConnectionStatus('Connection failed - Running in local mode 💾');
            this.fallbackToLocalMode();
        }
    }

    initializeEventListeners() {
        debugLog('Setting up event listeners...');

        // Mobile keyboard handling
        this.setupMobileKeyboardHandling();

        // Send message on button click
        this.sendBtn.addEventListener('click', () => {
            debugLog('📤 Send button clicked');
            this.sendMessage();
        });

        // Send message on Enter key
        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                debugLog('📤 Enter key pressed');
                this.sendMessage();
            }
        });

        // Handle typing indicators and button state
        this.messageInput.addEventListener('input', () => {
            const hasText = this.messageInput.value.trim().length > 0;
            this.sendBtn.disabled = !hasText;

            if (hasText) {
                this.handleTyping();
            } else {
                this.stopTyping();
            }

            // Auto-resize textarea
            this.resizeTextarea();
        });

        // Stop typing when focus is lost
        this.messageInput.addEventListener('blur', () => {
            this.stopTyping();
        });

        // Close reaction menu when clicking elsewhere
        document.addEventListener('click', (e) => {
            if (this.currentReactionMenu &&
                !this.currentReactionMenu.contains(e.target) &&
                !e.target.classList.contains('reaction-btn')) {
                this.closeReactionMenu();
            }
        });

        // Online users modal functionality
        this.userCountElement.addEventListener('click', () => {
            debugLog('👥 User count clicked - showing online users');
            this.showOnlineUsersModal();
        });

        // Close modal button
        const closeModalBtn = document.getElementById('closeModalBtn');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => {
                this.hideOnlineUsersModal();
            });
        }

        // Close modal when clicking outside
        const modal = document.getElementById('onlineUsersModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.hideOnlineUsersModal();
                }
            });
        }

        // Close modal with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.hideOnlineUsersModal();
            }
        });

        // Notification close button
        const notificationCloseBtn = document.getElementById('notificationClose');
        if (notificationCloseBtn) {
            notificationCloseBtn.addEventListener('click', () => {
                this.hideNotification();
            });
        }

        // Initial button state
        this.sendBtn.disabled = true;

        debugLog('✅ Event listeners set up');
    }

    ensurePresenceToastsContainer() {
        if (this.presenceToasts) return this.presenceToasts;
        const chatContainer = document.querySelector('.chat-container');
        if (!chatContainer) return null;
        const container = document.createElement('div');
        container.className = 'presence-toasts';
        chatContainer.appendChild(container);
        this.presenceToasts = container;
        return container;
    }

    showPresenceToast(type, username) {
        const container = this.ensurePresenceToastsContainer();
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `presence-toast ${type}`;
        const now = new Date();
        const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const icon = type === 'join' ? '🟢' : '🔴';
        toast.innerHTML = `<span class="icon">${icon}</span><span class="name">${this.escapeHtml(username)}</span><span class="meta">${type === 'join' ? 'joined' : 'left'} • ${time}</span><button class="close-btn" aria-label="Dismiss">×</button>`;
        container.appendChild(toast);

        const closeBtn = toast.querySelector('.close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toast.classList.add('fade-out');
                setTimeout(() => {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                }, 320);
            });
        }

        const autoTimer = setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => {
                if (toast.parentNode) toast.parentNode.removeChild(toast);
            }, 520);
        }, 5000);
    }

    resizeTextarea() {
        this.messageInput.style.height = 'auto';
        this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 100) + 'px';
    }

    handleTyping() {
        if (!this.typing) {
            this.typing = true;

            // Show typing indicator locally if not connected
            if (!this.isConnected || !this.socket) {
                this.showTypingIndicator(this.username);
            } else {
                this.socket.emit('typing', { username: this.username });
            }
        }

        // Clear existing timeout
        if (this.typingTimeout) {
            clearTimeout(this.typingTimeout);
        }

        // Set timeout to stop typing indicator
        this.typingTimeout = setTimeout(() => {
            this.stopTyping();
        }, 1000);
    }

    stopTyping() {
        if (this.typing) {
            this.typing = false;

            if (this.isConnected && this.socket) {
                this.socket.emit('stop typing', { username: this.username });
            } else {
                // Hide typing indicator locally if not connected
                this.hideTypingIndicator(this.username);
            }
        }

        if (this.typingTimeout) {
            clearTimeout(this.typingTimeout);
            this.typingTimeout = null;
        }
    }

    sendMessage() {
        const messageText = this.messageInput.value.trim();
        if (!messageText) {
            debugLog('⚠️ Attempted to send empty message');
            return;
        }

        debugLog(`📤 Sending message: "${messageText}"`);

        // Stop typing indicator
        this.stopTyping();

        // Create message object with unique ID
        const messageId = String(Date.now() + Math.random());
        const messageData = {
            id: messageId,
            username: this.username,
            message: messageText,
            timestamp: new Date().toISOString(),
            isMyMessage: true,
            reactions: {}
        };

        this.messageCount++;

        if (this.isConnected && this.socket) {
            debugLog('📡 Sending via Socket.IO...');
            // Send via Socket.IO for real-time delivery
            this.socket.emit('chat message', {
                username: messageData.username,
                message: messageData.message,
                timestamp: messageData.timestamp,
                id: messageData.id
            });
        } else {
            debugLog('💾 Socket not connected, adding message locally only');
            // Fallback to local display if not connected
            this.addMessage(messageData.username, messageData.message, true, messageData.timestamp, messageData.id, messageData.reactions);
        }

        // Clear input and reset textarea
        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.sendBtn.disabled = true;

        debugLog('✅ Message sent and input cleared');
    }

    addMessage(username, text, isMyMessage = false, timestamp = null, messageId = null, reactions = {}) {
        debugLog(`📝 Adding message to UI: ${username}: ${text}`);

        // Remove any existing typing indicators for this user
        this.hideTypingIndicator(username);

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isMyMessage ? 'my-message' : 'other-message'}`;
        messageDiv.setAttribute('data-username', username);

        // Generate message ID if not provided - ensure it's a string
        if (!messageId) {
            messageId = String(Date.now() + Math.random());
        }
        messageDiv.setAttribute('data-message-id', String(messageId));

        // Store reactions state for this message
        this.messageReactions.set(messageId, { ...reactions });

        const messageTime = timestamp ? new Date(timestamp) : new Date();
        const time = messageTime.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        // Create reactions HTML
        const reactionsHtml = this.createReactionsHtml(reactions, messageId);

        messageDiv.innerHTML = `
                    <div class="message-header">
                        <span class="message-username">${this.escapeHtml(username)}</span>
                        <span class="message-time">${time}</span>
                    </div>
                    <div class="message-text">${this.escapeHtml(text)}</div>
                    <div class="message-reactions">
                        ${reactionsHtml}
                        <button class="reaction-btn" data-message-id="${messageId}">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
                                <circle cx="9" cy="10" r="1.2"/>
                                <circle cx="15" cy="10" r="1.2"/>
                                <path d="M8 14c1.2 1.5 3 2.2 4 2.2s2.8-.7 4-2.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                            </svg>
                        </button>
                    </div>
                `;

        // Add event listener for reaction button
        const reactionBtn = messageDiv.querySelector('.reaction-btn');
        if (reactionBtn) {
            reactionBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showReactionMenu(messageId, reactionBtn);
            });
        }

        // Add event listeners for existing reaction badges
        const reactionBadges = messageDiv.querySelectorAll('.reaction-badge');
        reactionBadges.forEach(badge => {
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                const reaction = badge.getAttribute('data-reaction');
                this.toggleReaction(messageId, reaction);
            });
        });

        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();

        debugLog(`✅ Message added to UI successfully with ID: ${messageId}`);
    }

    createReactionsHtml(reactions, messageId) {
        if (!reactions || Object.keys(reactions).length === 0) {
            return '';
        }

        let reactionsHtml = '';
        for (const [reaction, users] of Object.entries(reactions)) {
            if (users && Array.isArray(users) && users.length > 0) {
                const hasMyReaction = users.includes(this.username);
                const badgeClass = hasMyReaction ? 'reaction-badge my-reaction' : 'reaction-badge';

                reactionsHtml += `
                            <span class="${badgeClass}" data-reaction="${reaction}" data-message-id="${messageId}">
                                ${reaction} ${users.length}
                            </span>
                        `;
            }
        }
        return reactionsHtml;
    }

    showReactionMenu(messageId, triggerElement) {
        debugLog(`😀 Showing reaction menu for message: ${messageId}`);

        // Close existing menu
        this.closeReactionMenu();

        const menu = document.createElement('div');
        menu.className = 'reaction-menu';

        // Check if user already has a reaction on this message using stored state
        const reactions = this.messageReactions.get(messageId) || {};
        let currentReaction = null;
        for (const [reaction, users] of Object.entries(reactions)) {
            if (users.includes(this.username)) {
                currentReaction = reaction;
                break;
            }
        }

        // Create reaction option buttons
        this.availableReactions.forEach(reaction => {
            const button = document.createElement('button');
            button.className = 'reaction-option';
            button.textContent = reaction;

            // Highlight current reaction if user has one
            if (currentReaction === reaction) {
                button.classList.add('current-reaction');
                button.title = 'Click to remove this reaction';
            } else if (currentReaction) {
                button.title = 'Click to replace your current reaction';
            } else {
                button.title = 'Click to add reaction';
            }

            button.addEventListener('click', (e) => {
                e.stopPropagation();
                this.addReaction(messageId, reaction);
                this.closeReactionMenu();
            });
            menu.appendChild(button);
        });

        // Position menu
        const triggerRect = triggerElement.getBoundingClientRect();

        menu.style.position = 'fixed';
        menu.style.left = `${triggerRect.left}px`;
        menu.style.top = `${triggerRect.bottom + 5}px`;
        menu.style.zIndex = '1000';

        // Adjust position if menu would go off-screen
        document.body.appendChild(menu);
        const menuRect = menu.getBoundingClientRect();

        // Adjust horizontal position
        if (menuRect.right > window.innerWidth - 10) {
            menu.style.left = `${triggerRect.right - menuRect.width}px`;
        }

        // Adjust vertical position
        if (menuRect.bottom > window.innerHeight - 10) {
            menu.style.top = `${triggerRect.top - menuRect.height - 5}px`;
        }

        this.currentReactionMenu = menu;
        debugLog('✅ Reaction menu created and positioned');
    }

    closeReactionMenu() {
        if (this.currentReactionMenu) {
            this.currentReactionMenu.remove();
            this.currentReactionMenu = null;
            debugLog('🗑️ Reaction menu closed');
        }
    }

    addReaction(messageId, reaction) {
        debugLog(`😀 Adding reaction ${reaction} to message ${messageId}`);

        // Check if user already has this reaction using stored state
        const reactions = this.messageReactions.get(messageId) || {};
        for (const [existingReaction, users] of Object.entries(reactions)) {
            if (users.includes(this.username)) {
                if (existingReaction === reaction) {
                    debugLog(`⚠️ User already has this reaction: ${reaction}`);
                    return; // Already have this reaction
                }
                // If different reaction, it will be replaced by the server
                break;
            }
        }

        if (this.isConnected && this.socket) {
            // Send reaction to server
            this.socket.emit('message reaction', {
                messageId: String(messageId),
                reaction: reaction,
                username: this.username,
                action: 'add'
            });
        } else {
            // Handle locally
            this.updateMessageReactions(messageId, reaction, this.username, 'add');
        }
    }

    toggleReaction(messageId, reaction) {
        debugLog(`🔄 Toggling reaction ${reaction} on message ${messageId}`);

        // Check if user already has this reaction using stored state
        const reactions = this.messageReactions.get(messageId) || {};
        let hasMyReaction = false;
        let hasAnyMyReaction = false;

        for (const [reactionType, users] of Object.entries(reactions)) {
            if (users.includes(this.username)) {
                hasAnyMyReaction = true;
                if (reactionType === reaction) {
                    hasMyReaction = true;
                }
            }
        }

        let action;
        if (hasMyReaction) {
            // User has this reaction, so remove it
            action = 'remove';
        } else if (hasAnyMyReaction) {
            // User has a different reaction, so replace it (server will handle this)
            action = 'add';
        } else {
            // User has no reaction, so add this one
            action = 'add';
        }

        if (this.isConnected && this.socket) {
            this.socket.emit('message reaction', {
                messageId: String(messageId),
                reaction: reaction,
                username: this.username,
                action: action
            });
        } else {
            this.updateMessageReactions(messageId, reaction, this.username, action);
        }
    }

    updateMessageReactions(messageId, reaction, username, action) {
        debugLog(`😀 Updating reactions for message ${messageId}: ${action} ${reaction} by ${username}`);

        const messageElement = document.querySelector(`[data-message-id="${String(messageId)}"]`);
        if (!messageElement) {
            debugLog(`⚠ Message element not found for ID: ${messageId}`);
            return;
        }

        let reactionsContainer = messageElement.querySelector('.message-reactions');
        if (!reactionsContainer) {
            debugLog(`⚠ Reactions container not found for message ${messageId}`);
            return;
        }

        // Get current reactions state for this message
        let reactions = this.messageReactions.get(messageId) || {};

        // Update reactions based on action
        if (action === 'add') {
            // Remove any existing reactions by this user first (one reaction per user)
            for (const [existingReaction, users] of Object.entries(reactions)) {
                const userIndex = users.indexOf(username);
                if (userIndex > -1) {
                    users.splice(userIndex, 1);
                    debugLog(`Removed existing reaction ${existingReaction} by ${username}`);

                    // Remove reaction if no users left
                    if (users.length === 0) {
                        delete reactions[existingReaction];
                    }
                }
            }

            // Add new reaction
            if (!reactions[reaction]) {
                reactions[reaction] = [username];
            } else {
                // Check if user already reacted
                if (!reactions[reaction].includes(username)) {
                    reactions[reaction].push(username);
                }
            }
        } else if (action === 'remove') {
            if (reactions[reaction]) {
                const index = reactions[reaction].indexOf(username);
                if (index > -1) {
                    reactions[reaction].splice(index, 1);
                }
                // Remove reaction if no users left
                if (reactions[reaction].length === 0) {
                    delete reactions[reaction];
                }
            }
        }

        // Update stored reactions state
        this.messageReactions.set(messageId, reactions);

        // Update reactions display
        const reactionsHtml = this.createReactionsHtml(reactions, messageId);
        reactionsContainer.innerHTML = reactionsHtml + `
                    <button class="reaction-btn" data-message-id="${messageId}">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>
                            <circle cx="9" cy="10" r="1.2"/>
                            <circle cx="15" cy="10" r="1.2"/>
                            <path d="M8 14c1.2 1.5 3 2.2 4 2.2s2.8-.7 4-2.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                        </svg>
                    </button>
                `;

        // Re-attach event listeners
        const newReactionBtn = reactionsContainer.querySelector('.reaction-btn');
        newReactionBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showReactionMenu(messageId, newReactionBtn);
        });

        const newReactionBadges = reactionsContainer.querySelectorAll('.reaction-badge');
        newReactionBadges.forEach(badge => {
            badge.addEventListener('click', (e) => {
                e.stopPropagation();
                const reactionType = badge.getAttribute('data-reaction');
                this.toggleReaction(messageId, reactionType);
            });
        });

        debugLog(`✅ Reactions updated for message ${messageId}`);
    }

    addSystemMessage(text, timestamp = null) {
        debugLog(`📢 Adding system message: ${text}`);

        const messageDiv = document.createElement('div');
        messageDiv.className = 'system-message';

        const messageTime = timestamp ? new Date(timestamp) : new Date();
        const time = messageTime.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        messageDiv.innerHTML = `
                    <div class="system-text">${this.escapeHtml(text)}</div>
                    <div class="system-time">${time}</div>
                `;

        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();
    }

    showTypingIndicator(username) {
        // Remove existing typing indicator for this user
        this.hideTypingIndicator(username);

        const typingDiv = document.createElement('div');
        typingDiv.className = 'typing-indicator';
        typingDiv.setAttribute('data-typing-user', username);

        typingDiv.innerHTML = `
                    <div class="typing-user">${this.escapeHtml(username)} is typing</div>
                    <div class="typing-dots">
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>
                `;

        this.messagesContainer.appendChild(typingDiv);
        this.scrollToBottom();
    }

    hideTypingIndicator(username) {
        const existingIndicator = this.messagesContainer.querySelector(`[data-typing-user="${username}"]`);
        if (existingIndicator) {
            existingIndicator.remove();
        }
    }

    updateConnectionStatus(message) {
        debugLog(`🔗 Connection status: ${message}`);
        const greenDot = `<svg width="10" height="10" viewBox="0 0 10 10" style="vertical-align: 0; margin-left: 4px;"><circle cx="5" cy="5" r="5" fill="#48bb78"/></svg>`;
        const safeHtml = this.escapeHtml(message).replace('🟢', greenDot);
        this.connectionStatus.innerHTML = safeHtml;

        let welcomeMessage = this.messagesContainer.querySelector('.welcome-message');
        if (!welcomeMessage) {
            welcomeMessage = document.createElement('div');
            welcomeMessage.className = 'welcome-message';
            this.messagesContainer.appendChild(welcomeMessage);
        }
        welcomeMessage.textContent = message;
    }

    updateUserCount(count) {
        debugLog(`👥 User count: ${count}`);
        this.userCountElement.innerHTML = `
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: -2px; margin-right: 4px;">
                        <circle cx="9" cy="8" r="3"/>
                        <path d="M3 18c0-3 3-5 6-5s6 2 6 5v1H3v-1z"/>
                        <circle cx="17" cy="9" r="2.5"/>
                        <path d="M14.5 18c0-2 2.5-3.5 4.5-3.5S23 16 23 18v1h-8.5v-1z"/>
                    </svg>
                    ${count} online`;
    }

    showOnlineUsersModal() {
        debugLog('👥 Showing online users modal');
        const modal = document.getElementById('onlineUsersModal');
        const usersList = document.getElementById('onlineUsersList');

        if (modal && usersList) {
            // Request current online users list from server if connected
            if (this.isConnected && this.socket) {
                debugLog('📡 Requesting current online users list from server');
                this.socket.emit('get online users');

                // Add a small delay to allow server response, then populate with current data
                setTimeout(() => {
                    this.populateOnlineUsersList(usersList);
                }, 100);
            } else {
                // Populate the users list with current data immediately for local mode
                this.populateOnlineUsersList(usersList);
            }

            // Show the modal
            modal.classList.add('show');
            document.body.style.overflow = 'hidden'; // Prevent background scrolling
        }
    }

    hideOnlineUsersModal() {
        debugLog('👥 Hiding online users modal');
        const modal = document.getElementById('onlineUsersModal');

        if (modal) {
            modal.classList.remove('show');
            document.body.style.overflow = ''; // Restore scrolling
        }
    }

    populateOnlineUsersList(usersListElement) {
        debugLog(`👥 Populating online users list with ${this.onlineUsers.size} users`);
        debugLog(`👥 Current online users: ${Array.from(this.onlineUsers).join(', ')}`);

        // Clear existing list
        usersListElement.innerHTML = '';

        if (this.onlineUsers.size === 0) {
            usersListElement.innerHTML = `
                        <div class="no-users-message">
                            No users currently online
                        </div>
                    `;
            return;
        }

        // Convert Set to Array and sort alphabetically
        const sortedUsers = Array.from(this.onlineUsers).sort();

        sortedUsers.forEach(username => {
            const userItem = document.createElement('div');
            userItem.className = 'online-user-item';

            // Get first letter for avatar
            const firstLetter = username.charAt(0).toUpperCase();

            // Check if this is the current user
            const isCurrentUser = username === this.username;

            userItem.innerHTML = `
                        <div class="online-user-avatar">
                            ${firstLetter}
                        </div>
                        <div class="online-user-info">
                            <div class="online-user-name">
                                ${this.escapeHtml(username)}
                                ${isCurrentUser ? ' (You)' : ''}
                            </div>
                            <div class="online-user-status">
                                <div class="online-indicator"></div>
                                Online now
                            </div>
                        </div>
                    `;

            usersListElement.appendChild(userItem);
        });
    }

    // Method to refresh the online users list in the modal
    refreshOnlineUsersList() {
        const modal = document.getElementById('onlineUsersModal');
        const usersList = document.getElementById('onlineUsersList');

        if (modal && modal.classList.contains('show') && usersList) {
            debugLog('🔄 Refreshing online users list in modal');
            this.populateOnlineUsersList(usersList);
        }
    }

    scrollToBottom() {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    setupMobileKeyboardHandling() {
        debugLog('📱 Setting up mobile keyboard handling...');

        // Handle viewport changes on mobile
        let initialViewportHeight = window.innerHeight;
        let isKeyboardOpen = false;

        const handleViewportChange = () => {
            const currentHeight = window.innerHeight;
            const heightDifference = initialViewportHeight - currentHeight;

            // If height decreased significantly, keyboard is likely open
            if (heightDifference > 150) {
                if (!isKeyboardOpen) {
                    debugLog('📱 Keyboard opened');
                    isKeyboardOpen = true;
                    this.handleKeyboardOpen();
                }
            } else {
                if (isKeyboardOpen) {
                    debugLog('📱 Keyboard closed');
                    isKeyboardOpen = false;
                    this.handleKeyboardClose();
                }
            }
        };

        // Listen for viewport changes
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('orientationchange', () => {
            // Reset initial height after orientation change
            setTimeout(() => {
                initialViewportHeight = window.innerHeight;
                handleViewportChange();
            }, 500);
        });

        // Handle input focus/blur for additional keyboard detection
        this.messageInput.addEventListener('focus', () => {
            debugLog('📱 Input focused');
            setTimeout(() => {
                this.scrollToBottom();
            }, 300);
        });

        this.messageInput.addEventListener('blur', () => {
            debugLog('📱 Input blurred');
        });
    }

    handleKeyboardOpen() {
        // Ensure input is visible when keyboard opens
        setTimeout(() => {
            this.scrollToBottom();
            this.messageInput.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }, 100);
    }

    handleKeyboardClose() {
        // Reset scroll position when keyboard closes
        setTimeout(() => {
            this.scrollToBottom();
        }, 100);
    }

    showError(message) {
        debugLog(`⚠ Error: ${message}`);
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = `Error: ${message}`;
        this.messagesContainer.appendChild(errorDiv);
        this.scrollToBottom();

        // Remove error after 5 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.parentNode.removeChild(errorDiv);
            }
        }, 5000);
    }

    hideNotification() {
        debugLog('🔔 Hiding notification banner');
        const notificationBanner = document.getElementById('notificationBanner');
        if (notificationBanner) {
            // Add fade out animation
            notificationBanner.style.animation = 'notificationSlideOut 0.3s ease-in forwards';

            // Remove element after animation
            setTimeout(() => {
                if (notificationBanner.parentNode) {
                    notificationBanner.parentNode.removeChild(notificationBanner);
                }
            }, 300);
        }
    }
}

// Prevent mobile viewport shift on page load
function preventViewportShift() {
    // Set initial viewport height
    const setViewportHeight = () => {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
    };

    setViewportHeight();
    window.addEventListener('resize', setViewportHeight);
    window.addEventListener('orientationchange', () => {
        setTimeout(setViewportHeight, 100);
    });
}

// Initialize chat when page loads
document.addEventListener('DOMContentLoaded', () => {
    debugLog('🚀 DOM loaded, initializing chat...');
    preventViewportShift();
    window.chatApp = new RealTimeChatApp();
});
