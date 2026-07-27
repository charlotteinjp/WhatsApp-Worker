const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const { Client, LocalAuth } = require('whatsapp-web.js');
const mysql = require('mysql2/promise');

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

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'WhatsApp Server Running',
    uptime: process.uptime()
  });
});

// Database connection using environment variables
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'whatsapp_dashboard',
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 10000
});

// Test database connection
async function testDatabaseConnection() {
  try {
    const connection = await pool.getConnection();
    console.log('✅ Database connected successfully');
    connection.release();
    return true;
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    return false;
  }
}

// Save message to database
async function saveMessage(sender, body, timestamp) {
  try {
    const [existing] = await pool.execute(
      'SELECT id FROM whatsapp_messages WHERE sender = ? AND body = ? AND ABS(timestamp - ?) < 2000',
      [sender, body, timestamp]
    );
    
    if (existing.length === 0) {
      await pool.execute(
        'INSERT INTO whatsapp_messages (sender, body, timestamp) VALUES (?, ?, ?)',
        [sender, body, timestamp]
      );
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error saving message:', error.message);
    return false;
  }
}

// Get recent messages
async function getRecentMessages(limit = 50) {
  try {
    const [rows] = await pool.execute(
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
    console.error('Error fetching messages:', error.message);
    return [];
  }
}

// WhatsApp Client setup
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.AUTH_PATH || './.wwebjs_auth'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

// WhatsApp Events
client.on('qr', (qr) => {
  console.log('\n📱 ======================================');
  console.log('   SCAN THIS QR CODE WITH WHATSAPP');
  console.log('========================================\n');
  
  // Show QR in terminal
  try {
    require('qrcode-terminal').generate(qr, { small: true });
  } catch (e) {
    console.log('QR Code (raw):', qr);
  }
  
  // Send to all connected browsers
  io.emit('qr', qr);
  console.log('\nQR sent to connected clients\n');
});

client.on('ready', () => {
  console.log('\n✅ WhatsApp is connected and ready!\n');
  io.emit('ready');
});

client.on('authenticated', () => {
  console.log('🔐 WhatsApp authenticated successfully');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
});

client.on('disconnected', (reason) => {
  console.log('🔌 WhatsApp disconnected:', reason);
  io.emit('disconnected');
  
  // Try to reconnect after 5 seconds
  setTimeout(() => {
    console.log('🔄 Attempting to reconnect...');
    client.initialize();
  }, 5000);
});

// Handle incoming messages
client.on('message', async (message) => {
  // Only process incoming messages (not sent by us)
  if (!message.fromMe && message.body) {
    try {
      const contact = await message.getContact();
      const sender = contact.pushname || contact.name || message.from.split('@')[0];
      const timestamp = message.timestamp * 1000;
      
      const isNew = await saveMessage(sender, message.body, timestamp);
      
      if (isNew) {
        const msgData = {
          sender: sender,
          body: message.body,
          timestamp: new Date(timestamp).toISOString(),
          isHistorical: false
        };
        
        // Broadcast to all connected browsers
        io.emit('message', msgData);
        
        console.log(`📨 ${sender}: ${message.body.substring(0, 50)}${message.body.length > 50 ? '...' : ''}`);
      }
    } catch (err) {
      console.error('Error processing message:', err.message);
    }
  }
});

// Handle media messages
client.on('message_create', async (message) => {
  if (!message.fromMe && message.type !== 'chat') {
    try {
      const contact = await message.getContact();
      const sender = contact.pushname || contact.name || message.from.split('@')[0];
      const timestamp = message.timestamp * 1000;
      
      let body = message.body || '';
      if (!body) {
        // Describe media types
        switch(message.type) {
          case 'image': body = '📷 Image'; break;
          case 'video': body = '🎥 Video'; break;
          case 'sticker': body = '🏷️ Sticker'; break;
          case 'audio': body = '🎵 Audio'; break;
          case 'document': body = '📄 Document'; break;
          case 'ptt': body = '🎤 Voice Message'; break;
          default: body = `[${message.type}]`; break;
        }
      }
      
      await saveMessage(sender, body, timestamp);
      
      io.emit('message', {
        sender: sender,
        body: body,
        timestamp: new Date(timestamp).toISOString(),
        isHistorical: false
      });
    } catch (err) {
      console.error('Error processing media message:', err.message);
    }
  }
});

// Socket.IO connection handling
io.on('connection', async (socket) => {
  console.log('🟢 Browser client connected:', socket.id);
  
  // Send current state to newly connected client
  try {
    if (client.info) {
      // WhatsApp is connected
      socket.emit('ready');
      
      // Send recent messages from database
      const recentMessages = await getRecentMessages(50);
      if (recentMessages.length > 0) {
        recentMessages.forEach(msg => {
          socket.emit('message', msg);
        });
        console.log(`📤 Sent ${recentMessages.length} recent messages to client`);
      }
      
      socket.emit('historyLoaded');
    } else {
      // WhatsApp not connected yet
      socket.emit('status', { message: 'Waiting for WhatsApp connection...' });
    }
  } catch (error) {
    console.error('Error sending initial data:', error.message);
  }
  
  // Handle client disconnection
  socket.on('disconnect', () => {
    console.log('🔴 Browser client disconnected:', socket.id);
  });
  
  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error.message);
  });
});

// Start the server
const PORT = process.env.PORT || 10000;

async function startServer() {
  // Test database connection first
  const dbConnected = await testDatabaseConnection();
  
  if (!dbConnected) {
    console.warn('⚠️  Database not connected. Messages will not be saved.');
    console.warn('Please check your DB_HOST, DB_USER, DB_PASSWORD, DB_NAME environment variables.');
  }
  
  server.listen(PORT, () => {
    console.log('\n🚀 WhatsApp Server is running!');
    console.log(`   Port: ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/`);
    console.log('   Waiting for WhatsApp QR code...\n');
  });
  
  // Initialize WhatsApp client
  client.initialize();
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await client.destroy();
  server.close();
  process.exit(0);
});

// Start everything
startServer();
