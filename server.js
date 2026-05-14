const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Create a basic HTTP server to handle health checks
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Retell AI - OpenClaw Proxy Server is running.');
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (retellWs) => {
    console.log('Retell AI connected via WebSocket');

    let isAuthenticated = false;
    let retellMessageQueue = [];

    // Step 1: The Initial Connection (Bypass the WAF)
    // MUST include the headers object as the second argument, passing a valid User-Agent.
    const openclawWs = new WebSocket(process.env.OPENCLAW_WSS_URL, {
        headers: { 'User-Agent': 'Node.js/365Digital-Proxy' }
    });

    // Step 2: The Silent Open
    // Do NOT send any authentication tokens. Log that the connection is open, but wait silently.
    openclawWs.on('open', () => {
        console.log('OpenClaw WebSocket connection is open. Waiting silently for challenge...');
    });

    // Step 3: The Challenge-Response Handshake
    openclawWs.on('message', (data) => {
        const rawMessage = data.toString();
        console.log('[OpenClaw -> Proxy] Received:', rawMessage);
        
        if (!isAuthenticated) {
            try {
                const parsedMessage = JSON.parse(rawMessage);
                if (parsedMessage.event === 'connect.challenge') {
                    console.log('Received connect.challenge from OpenClaw. Sending auth response...');
                    
                    const authPayload = {
                        "method": "connect", 
                        "params": {
                            "auth": {
                                "token": (process.env.MYCLAW_API_KEY || '').trim()
                            }
                        }
                    };
                    
                    console.log('[Proxy -> OpenClaw] Sending:', JSON.stringify(authPayload));
                    openclawWs.send(JSON.stringify(authPayload));
                    
                    // We will NOT set isAuthenticated = true yet, nor flush the queue.
                    // We need to wait and see if OpenClaw sends a success response or closes!
                    return; 
                }

                // If we get here, OpenClaw sent something else while we were not authenticated.
                // Could be the success response!
                if (parsedMessage.event === 'connect.success' || parsedMessage.result || parsedMessage.status === 'success') {
                    console.log('Received success response from OpenClaw! Now routing audio...');
                    isAuthenticated = true;
                    while (retellMessageQueue.length > 0) {
                        const queuedData = retellMessageQueue.shift();
                        // console.log('[Proxy -> OpenClaw] Flushing queued Retell message...');
                        openclawWs.send(queuedData);
                    }
                    return;
                }
            } catch (error) {
                console.log('Error parsing OpenClaw message during auth phase:', error.message);
            }
        }

        // Step 4: The Audio Pipeline (vice versa - OpenClaw to Retell)
        // Only route after the challenge is successfully answered
        if (isAuthenticated) {
            if (retellWs.readyState === WebSocket.OPEN) {
                retellWs.send(data);
            }
        }
    });

    openclawWs.on('error', (error) => {
        console.error('OpenClaw WebSocket error:', error.message);
    });

    openclawWs.on('close', (code, reason) => {
        console.log(`OpenClaw WebSocket closed: Code ${code}, Reason: ${reason}`);
        if (retellWs.readyState === WebSocket.OPEN) {
            retellWs.close();
        }
    });

    // Step 4: The Audio Pipeline (Retell to OpenClaw)
    retellWs.on('message', (data) => {
        // Only route after the challenge is answered
        if (!isAuthenticated) {
            // Queue messages while waiting for OpenClaw to authenticate
            retellMessageQueue.push(data);
            return;
        }

        if (openclawWs.readyState === WebSocket.OPEN) {
            openclawWs.send(data);
        }
    });

    retellWs.on('close', () => {
        console.log('Retell AI disconnected');
        if (openclawWs.readyState === WebSocket.OPEN) {
            openclawWs.close();
        }
    });
    
    retellWs.on('error', (error) => {
        console.error('Retell WebSocket error:', error.message);
    });
});

server.listen(PORT, () => {
    console.log(`WebSocket Server listening on port ${PORT}`);
});
