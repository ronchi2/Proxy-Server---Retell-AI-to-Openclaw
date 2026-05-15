const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Create a basic HTTP server to handle Render health checks
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
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

    // Step 1: The Initial Connection (Bypass the WAF completely)
    // We pass User-Agent AND Origin to ensure OpenClaw never throws a 1008 'ua=n/a' error.
    const openclawWs = new WebSocket(process.env.OPENCLAW_WSS_URL, {
        headers: {
            'User-Agent': 'Node.js/365Digital-Proxy',
            'Origin': process.env.OPENCLAW_WSS_URL.replace('wss://', 'https://').replace('ws://', 'http://')
        }
    });

    // Step 2: The Silent Open
    openclawWs.on('open', () => {
        console.log('>>> OpenClaw WebSocket connection is open. Waiting silently for challenge...');
    });

    // Step 3 & 4: Challenge-Response & The Steel Trap Filter
    openclawWs.on('message', (data) => {
        const rawMessage = data.toString();
        let msg;

        try {
            msg = JSON.parse(rawMessage);
        } catch (error) {
            console.error('Error parsing OpenClaw message:', error.message);
            return;
        }

        // --- INTERCEPT SYSTEM EVENTS & AUTHENTICATE ---
        if (msg.event === 'connect.challenge') {
            console.log('<<< Received connect.challenge. Sending token...');
            const authPayload = {
                method: "connect",
                params: {
                    auth: {
                        token: (process.env.MYCLAW_API_KEY || '').trim()
                    }
                }
            };
            openclawWs.send(JSON.stringify(authPayload));
            return; // DROP: Do not send to Retell
        }

        // --- FILTER THE NOISE ---
        if (msg.event === 'connect.success' || msg.status === 'success' || msg.event === 'heartbeat' || msg.type === 'system') {
            if (!isAuthenticated && (msg.event === 'connect.success' || msg.status === 'success')) {
                console.log('>>> Authentication successful! Opening the pipeline.');
                isAuthenticated = true;

                // Flush queued messages from Retell
                while (retellMessageQueue.length > 0) {
                    openclawWs.send(retellMessageQueue.shift());
                }
            }
            return; // DROP: Do not send to Retell
        }

        // --- THE TRANSLATION LAYER ---
        let generatedText = null;

        // Hunt for the actual text in OpenClaw's payload
        if (msg.choices && msg.choices.length > 0) {
            generatedText = msg.choices[0].message?.content || msg.choices[0].delta?.content;
        } else if (msg.response !== undefined) {
            generatedText = msg.response;
        } else if (msg.content !== undefined) {
            generatedText = msg.content;
        } else if (msg.text !== undefined) {
            generatedText = msg.text;
        }

        // ONLY forward to Retell if text was successfully found. 
        // This is the steel trap that prevents the "content_complete not a boolean" crash.
        if (generatedText) {
            const retellResponse = {
                response_id: currentResponseId,
                content: generatedText,
                content_complete: true, // Tell Retell the sentence is finished
                end_call: false
            };

            if (retellWs.readyState === WebSocket.OPEN) {
                retellWs.send(JSON.stringify(retellResponse));
                console.log(`>>> Forwarded to Retell: "${generatedText.substring(0, 50)}..."`);
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

    // --- HANDLE INCOMING RETELL AUDIO EVENTS ---
    retellWs.on('message', (data) => {
        const rawData = data.toString();

        try {
            const parsedData = JSON.parse(rawData);
            // Grab the ID so Riley knows which sentence she is responding to
            if (parsedData.event === 'response_required') {
                currentResponseId = parsedData.response_id;
            }
        } catch (e) {
            // Ignore parse errors on raw audio chunks
        }

        // Queue events if OpenClaw is still doing the security handshake
        if (!isAuthenticated) {
            retellMessageQueue.push(data);
            return;
        }

        // Forward safely to OpenClaw
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
