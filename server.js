const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Render Health Check
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200);
        res.end('365Digital Proxy Server - Retell to OpenClaw is live.');
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (retellWs) => {
    console.log('>>> Retell AI connected via WebSocket');

    let isAuthenticated = false;
    let retellMessageQueue = [];
    let currentResponseId = 0; 

    // 1. Bypass WAF with Origin and User-Agent headers
    const wssUrl = process.env.OPENCLAW_WSS_URL || 'wss://api.openclaw.com/ws';
    const openclawWs = new WebSocket(wssUrl, {
        headers: { 
            'User-Agent': 'Node.js/365Digital-Proxy',
            'Origin': wssUrl.replace('wss://', 'https://').replace('ws://', 'http://')
        }
    });

    openclawWs.on('open', () => {
        console.log('>>> OpenClaw connection open. Waiting for challenge...');
    });

    openclawWs.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }

        // 2. PERFECT HANDSHAKE RESPONSE (The CLI Disguise)
        if (msg.event === 'connect.challenge') {
            console.log('<<< Received connect.challenge. Sending properly formatted req frame...');
            
            // OpenClaw Gateway Protocol requires us to use official "Allowed Values"
            const authPayload = {
                type: "req",
                id: "handshake-001",
                method: "connect", 
                params: {
                    minProtocol: 3,
                    maxProtocol: 4,
                    client: { 
                        id: "cli",             // Disguise proxy as the official CLI app
                        platform: "macos",     // Use an officially recognized platform
                        version: "1.2.3",      // Standard version string
                        mode: "operator"       // Required mode for two-way chatting
                    },
                    role: "operator",          // Declare our authorization role
                    auth: { token: (process.env.MYCLAW_API_KEY || '').trim() }
                }
            };
            openclawWs.send(JSON.stringify(authPayload));
            return; 
        }

        // 3. HANDSHAKE SUCCESS CHECK
        if (msg.type === 'res' && msg.id === 'handshake-001') {
            if (msg.ok) {
                console.log('>>> Authentication successful! Opening the pipeline.');
                isAuthenticated = true;
                
                // Release any audio events Retell queued up during the handshake
                while (retellMessageQueue.length > 0) {
                    openclawWs.send(retellMessageQueue.shift());
