const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const { userPool, whatsappPool } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

// Middleware
app.use(express.json());
app.use(session({
  secret: 'your-random-secret-' + Date.now(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// Serve React build
app.use(express.static(path.join(__dirname, 'build')));

// WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(__dirname, '.wwebjs_auth')
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  }
});

// Save message to WHATSAPP database
async function saveMessage(sender, body, timestamp) {
  try {
    const [existing] = await whatsappPool.execute(
      'SELECT id FROM whatsapp_messages WHERE sender = ? AND body = ? AND ABS(timestamp - ?) < 2000',
      [sender, body, timestamp]
    );
    
    if (existing.length === 0) {
      await whatsappPool.execute(
        'INSERT INTO whatsapp_messages (sender, body, timestamp) VALUES (?, ?, ?)',
        [sender, body, timestamp]
      );
      return true;
    }
    return false;
  } catch (error) {
    console.error('Save error:', error);
    return false;
  }
}

// Get messages from WHATSAPP database
async function getMessages(limit = 100) {
  try {
    const [rows] = await whatsappPool.execute(
      'SELECT sender, body, timestamp FROM whatsapp_messages ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );
    return rows.map(row => ({
      sender: row.sender,
      body: row.body,
      timestamp: new Date(row.timestamp).toISOString(),
      isHistorical: true
    }));
  } catch (error) {
    return [];
  }
}

// Update WhatsApp state
async function updateState(status, qrCode = null) {
  await whatsappPool.execute(
    'UPDATE whatsapp_state SET status = ?, qr_code = ? WHERE id = 1',
    [status, qrCode]
  );
}

// WhatsApp Events
client.on('qr', async (qr) => {
  console.log('QR received');
  await updateState('qr_ready', qr);
  io.emit('qr', qr);
});

client.on('ready', async () => {
  console.log('WhatsApp ready!');
  await updateState('connected');
  io.emit('ready');
});

client.on('message', async (message) => {
  if (!message.fromMe && message.body) {
    try {
      const contact = await message.getContact();
      const sender = contact.pushname || contact.name || message.from.split('@')[0];
      const timestamp = message.timestamp * 1000;
      
      const isNew = await saveMessage(sender, message.body, timestamp);
      
      if (isNew) {
        io.emit('message', {
          sender,
          body: message.body,
          timestamp: new Date(timestamp).toISOString(),
          isHistorical: false
        });
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  }
});

// Socket.IO
io.on('connection', async (socket) => {
  console.log('Client connected');
  
  // Check current WhatsApp state
  const [rows] = await whatsappPool.execute('SELECT status, qr_code FROM whatsapp_state WHERE id = 1');
  const state = rows[0];
  
  if (state.status === 'qr_ready' && state.qr_code) {
    socket.emit('qr', state.qr_code);
  } else if (state.status === 'connected' || client.info) {
    socket.emit('ready');
    const messages = await getMessages(50);
    messages.forEach(msg => socket.emit('message', msg));
    socket.emit('historyLoaded');
  }
});

// LOGIN - Uses your EXISTING users table in anniethe_radio_playout
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  try {
    // Query YOUR existing users table
    const [users] = await userPool.execute(
      'SELECT id, username, password_hash, display_name, admin FROM users WHERE username = ?',
      [username]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const user = users[0];
    
    // Verify against existing bcrypt hash ($2y$ format works with bcrypt)
    // Fix PHP $2y$ format for Node.js
    let passwordHash = user.password_hash;
    if (passwordHash.startsWith('$2y$')) {
      passwordHash = passwordHash.replace('$2y$', '$2b$');
    }
    
    const valid = await bcrypt.compare(password, passwordHash);
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.displayName = user.display_name || user.username;
    req.session.isAdmin = user.admin === 1;
    
    console.log(`User logged in: ${user.username} (Admin: ${user.admin === 1})`);
    
    res.json({ 
      success: true, 
      username: user.username,
      displayName: user.display_name || user.username,
      isAdmin: user.admin === 1
    });
    
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Check auth
app.get('/api/check-auth', (req, res) => {
  if (req.session.userId) {
    res.json({ 
      authenticated: true, 
      username: req.session.username,
      displayName: req.session.displayName,
      isAdmin: req.session.isAdmin
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get messages API
app.get('/api/messages', async (req, res) => {
  const messages = await getMessages(100);
  res.json(messages);
});

// Catch-all - serve React
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  client.initialize();
});
