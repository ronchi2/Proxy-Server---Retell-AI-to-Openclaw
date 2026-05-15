const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200);
        res.end('VERIFIED: ATTEMPT 10'); // Keeping this for proof
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
    
    // THE HAMMER HEADERS
    const openclawWs = new WebSocket(wssUrl, {
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': 'https://openclaw.com'
        }
    });

    openclawWs.on('open', () => {
        console.log('>>> [BRIDGE] Connected to Moltly. Waiting for challenge...');
    });

    openclawWs.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }

        if (msg.event === 'connect.challenge') {
            console.log('>>> [AUTH] Challenge received. Sending Handshake...');
            
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
            return; 
        }

        if (msg.type === 'res' && msg.id === 'handshake-001') {
            if (msg.ok) {
                console.log('>>> [SUCCESS] Auth passed. Pipeline is OPEN.');
                isAuthenticated = true;
                while (retellMessageQueue.length > 0) {
                    openclawWs.send(retellMessageQueue.shift());
                }
            } else {
                console.error('>>> [FAIL] Auth Rejected:', JSON.stringify(msg.error));
            }
            return;
        }

        if (msg.event === 'heartbeat' || msg.type === 'system') return;

        // Translation logic...
        let generatedText = null;
        const payload = msg.payload || msg;
        if (payload.choices && payload.choices.length > 0) {
            generatedText = payload.choices[0].delta?.content || payload.choices[0].message?.content;
        } else if (payload.content) {
            generatedText = payload.content;
        }

        if (generatedText) {
            const retellResponse = {
                response_id: currentResponseId,
                content: String(generatedText),
                content_complete: true,
                end_call: false
            };
            if (retellWs.readyState === WebSocket.OPEN) {
                retellWs.send(JSON.stringify(retellResponse));
            }
        }
    });

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
                console.log(`>>> [TALK] Sent: "${humanSpeech}"`);
            } else {
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
