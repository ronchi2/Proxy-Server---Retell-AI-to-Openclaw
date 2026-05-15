const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

// Render Health Check & Identity Proof
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200);
        res.end('VERIFIED: THE SHIELD IS ACTIVE.'); 
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (retellWs) => {
    console.log('>>> [BRIDGE] Retell AI connected.');

    let isAuthenticated = false;
    let retellMessageQueue = [];
    let currentResponseId = 0; 

    const wssUrl = (process.env.OPENCLAW_WSS_URL || '').trim();
    
    // 1. THE DISGUISE: Mimic a professional web client to bypass WAF
    const openclawWs = new WebSocket(wssUrl, {
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': 'https://openclaw.com',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    });

    openclawWs.on('open', () => {
        console.log('>>> [BRIDGE] Connected to Moltly. Waiting for challenge...');
    });

    openclawWs.on('message', (data) => {
        let msg;
        try { 
            msg = JSON.parse(data.toString()); 
        } catch (e) { 
            return; 
        }

        // 2. THE SHIELD: Intercept and handle Moltly system messages
        // We MUST NOT send these to Retell, or Retell will crash.
        if (msg.event === 'connect.challenge') {
            console.log('>>> [AUTH] Challenge received. Sending handshake...');
            const authPayload = {
                type: "req",
                id: "handshake-001",
                method: "connect", 
                params: {
                    minProtocol: 4,
                    maxProtocol: 4,
                    client: { 
                        id: "webchat", 
                        platform: "web", 
                        version: "2026.4.27", 
                        mode: "operator" 
                    },
                    auth: { token: (process.env.MYCLAW_API_KEY || '').trim() }
                }
            };
            openclawWs.send(JSON.stringify(authPayload));
            return; // STOP: Do not forward to Retell
        }

        if (msg.type === 'res' && msg.id === 'handshake-001') {
            if (msg.ok) {
                console.log('>>> [SUCCESS] Auth passed. Pipeline is OPEN.');
                isAuthenticated = true;
                // Release any human speech that was waiting for the handshake to finish
                while (retellMessageQueue.length > 0) {
                    openclawWs.send(retellMessageQueue.shift());
                }
            } else {
                console.error('>>> [FAIL] Auth Rejected:', JSON.stringify(msg.error));
            }
            return; // STOP: Do not forward to Retell
        }

        // Ignore system noise
        if (msg.event === 'heartbeat' || msg.type === 'system' || msg.event === 'connect.status') {
            return; 
        }

        // 3. TRANSLATION: OpenClaw Text -> Retell Audio
        let generatedText = null;
        const payload = msg.payload || msg;

        // Check various OpenClaw response formats
        if (payload.choices && payload.choices.length > 0) {
            generatedText = payload.choices[0].delta?.content || payload.choices[0].message?.content;
        } else if (payload.content) {
            generatedText = payload.content;
        } else if (payload.text) {
            generatedText = payload.text;
        }

        if (generatedText && retellWs.readyState === WebSocket.OPEN) {
            console.log(`>>> [RETELL] Sending text: "${String(generatedText).substring(0, 30)}..."`);
            const retellResponse = {
                response_id: currentResponseId,
                content: String(generatedText),
                content_complete: true,
                end_call: false
            };
            retellWs.send(JSON.stringify(retellResponse));
        }
    });

    // 4. TRANSLATION: Retell Human Speech -> OpenClaw Agent Request
    retellWs.on('message', (data) => {
        let parsedData;
        try { parsedData = JSON.parse(data.toString()); } catch (e) { return; }

        if (parsedData.event === 'response_required') {
            currentResponseId = parsedData.response_id;
            let humanSpeech = "";
            if (parsedData.transcript && parsedData.transcript.length > 0) {
                const lastMsg = parsedData.transcript[parsedData.transcript.length - 1];
                if (lastMsg.role === 'user') humanSpeech = lastMsg.content;
            }

            if (!humanSpeech) return;

            const openclawReq = {
                type: "req",
                id: `msg-${Date.now()}`,
                method: "agent",
                params: { text: humanSpeech }
            };

            const payloadStr = JSON.stringify(openclawReq);
            if (isAuthenticated && openclawWs.readyState === WebSocket.OPEN) {
                openclawWs.send(payloadStr);
                console.log(`>>> [TALK] Sent human voice to LLM: "${humanSpeech}"`);
            } else {
                console.log('>>> [WAIT] Queueing speech until auth finishes...');
                retellMessageQueue.push(payloadStr);
            }
        }
    });

    openclawWs.on('error', (err) => console.error('!!! [ERROR] Moltly:', err.message));
    
    openclawWs.on('close', (code, reason) => {
        console.log(`!!! [CLOSE] Moltly: ${code} ${reason}`);
        if (retellWs.readyState === WebSocket.OPEN) retellWs.close();
    });

    retellWs.on('close', () => {
        console.log('>>> [BRIDGE] Retell disconnected.');
        if (openclawWs.readyState === WebSocket.OPEN) openclawWs.close();
    });
});

server.listen(PORT, () => console.log(`Proxy active on port ${PORT}`));
