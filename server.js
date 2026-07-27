const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      'https://studio.onoradio.co.uk',
      'http://studio.onoradio.co.uk',
      'http://localhost:3000',
      'http://localhost:3001'
    ],
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Parse JSON bodies
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'WhatsApp Server Running' });
});

// Database connections
const userPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.USER_DB_NAME || 'anniethe_radio_playout',
  waitForConnections: true,
  connectionLimit: 5
});

const whatsappPool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.WHATSAPP_DB_NAME || 'whatsapp_dashboard',
  waitForConnections: true,
  connectionLimit: 5
});

// Login route - uses your EXISTING users table
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    const [users] = await userPool.execute(
      'SELECT id, username, password_hash, display_name, admin FROM users WHERE username = ?',
      [username]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    const user = users[0];
    
    // Handle PHP $2y$ format
    let passwordHash = user.password_hash;
    if (passwordHash.startsWith('$2y$')) {
      passwordHash = passwordHash.replace('$2y$', '$2b$');
    }
    
    const valid = await bcrypt.compare(password, passwordHash);
    
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    console.log(`✅ Login: ${user.username}`);
    
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

// Check auth (simple token check - clients send username back)
app.post('/api/verify', async (req, res) => {
  const { username } = req.body;
  
  if (!username) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  
  try {
    const [users] = await userPool.execute(
      'SELECT id, username, display_name, admin FROM users WHERE username = ?',
      [username]
    );
    
    if (users.length > 0) {
      res.json({ authenticated: true, username: users[0].username });
    } else {
      res.json({ authenticated: false });
    }
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// WhatsApp message functions
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
    console.error('Save error:', error.message);
    return false;
  }
}

async function getRecentMessages(limit = 50) {
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

// WhatsApp Client
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  }
});

client.on('qr', (qr) => {
  console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP\n');
  try {
    require('qrcode-terminal').generate(qr, { small: true });
  } catch (e) {
    console.log('QR:', qr.substring(0, 100) + '...');
  }
  io.emit('qr', qr);
});

client.on('ready', () => {
  console.log('✅ WhatsApp connected!');
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
        console.log(`📨 ${sender}: ${message.body.substring(0, 50)}`);
      }
    } catch (err) {
      console.error('Message error:', err.message);
    }
  }
});

client.on('disconnected', (reason) => {
  console.log('Disconnected:', reason);
  setTimeout(() => client.initialize(), 5000);
});

// Socket.IO
io.on('connection', async (socket) => {
  console.log('🟢 Client connected:', socket.id);
  
  if (client.info) {
    socket.emit('ready');
    const messages = await getRecentMessages(50);
    messages.forEach(msg => socket.emit('message', msg));
    socket.emit('historyLoaded');
  }
});

// Start
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on port ${PORT}\n`);
  client.initialize();
});
