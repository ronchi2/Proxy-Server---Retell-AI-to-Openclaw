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
    let currentResponseId = 0; // Track this so we can translate back to Retell

    // Step 1: The Initial Connection (Bypass the WAF)
    const openclawWs = new WebSocket(process.env.OPENCLAW_WSS_URL, {
        headers: { 'User-Agent': 'Node.js/365Digital-Proxy' }
    });

    // Step 2: The Silent Open
    openclawWs.on('open', () => {
        console.log('OpenClaw WebSocket connection is open. Waiting silently for challenge...');
    });

    // Step 3 & 4: The Challenge-Response Handshake and Intelligent Filter
    openclawWs.on('message', (data) => {
        const rawMessage = data.toString();
        let parsedMessage;

        try {
            parsedMessage = JSON.parse(rawMessage);
        } catch (error) {
            console.error('Error parsing OpenClaw message:', error.message);
            return;
        }

        // --- INTERCEPT SYSTEM EVENTS ---
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
            
            openclawWs.send(JSON.stringify(authPayload));
            return; // DO NOT FORWARD TO RETELL
        }

        // --- FILTER THE NOISE ---
        if (
            parsedMessage.event === 'connect.success' || 
            parsedMessage.event === 'heartbeat' || 
            parsedMessage.type === 'system' ||
            parsedMessage.status === 'success'
        ) {
            if (parsedMessage.event === 'connect.success' || parsedMessage.status === 'success') {
                console.log('Authentication successful! Now routing Retell events to OpenClaw.');
                isAuthenticated = true;
                
                // Flush queued messages from Retell
                while (retellMessageQueue.length > 0) {
                    const queuedData = retellMessageQueue.shift();
                    openclawWs.send(queuedData);
                }
            }
            return; // DO NOT FORWARD TO RETELL
        }

        // --- THE TRANSLATION LAYER ---
        // Try to extract actual speech/text content from the OpenClaw payload
        let generatedText = null;

        if (parsedMessage.choices && parsedMessage.choices.length > 0) {
            generatedText = parsedMessage.choices[0].message?.content || parsedMessage.choices[0].delta?.content;
        } else if (parsedMessage.response !== undefined) {
            generatedText = parsedMessage.response;
        } else if (parsedMessage.content !== undefined) {
            generatedText = parsedMessage.content;
        } else if (parsedMessage.text !== undefined) {
            generatedText = parsedMessage.text;
        }

        // Only forward to Retell if we actually extracted text
        if (generatedText) {
            const retellResponse = {
                response_id: currentResponseId,
                content: generatedText,
                content_complete: true, // Assuming full blocks. Set to false if streaming
                end_call: false
            };

            if (retellWs.readyState === WebSocket.OPEN) {
                retellWs.send(JSON.stringify(retellResponse));
                console.log(`Translated and forwarded response to Retell: "${generatedText.substring(0, 50)}..."`);
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

    // Handle incoming messages from Retell AI
    retellWs.on('message', (data) => {
        const rawData = data.toString();
        
        try {
            const parsedData = JSON.parse(rawData);
            
            // Track the active response ID so we can properly route the answer back
            if (parsedData.event === 'response_required') {
                currentResponseId = parsedData.response_id;
            }
        } catch (e) {
            // Ignore parse errors on incoming raw audio/events
        }

        // Queue events if OpenClaw hasn't finished the challenge-response yet
        if (!isAuthenticated) {
            retellMessageQueue.push(data);
            return;
        }

        // Forward to OpenClaw
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
