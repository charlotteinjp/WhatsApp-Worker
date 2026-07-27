# WhatsApp Web Bridge Server

Node.js server that connects to WhatsApp Web and broadcasts messages via Socket.IO.

## Setup

1. Clone the repo
2. Install dependencies: `npm install`
3. Set environment variables
4. Start: `npm start`

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DB_HOST` | MySQL host (e.g., yourdomain.com) |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `DB_NAME` | Database name |
| `PORT` | Server port (default: 10000) |
| `AUTH_PATH` | WhatsApp auth storage path (optional) |

## Deploy to Render

1. Create a new Web Service
2. Set the environment variables above
3. Deploy

## First Run

Check the logs for the QR code. Scan it with WhatsApp to connect.
