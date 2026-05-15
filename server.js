const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 10000; // Updated to match Render's preference

const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200);
        res.end('VERIFIED: THE IRON SHIELD IS ACTIVE.'); 
    } else {
        res.writeHead(404);
        res.end();
    }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (retellWs) => {
    console.log('>>> [BRIDGE] Retell connected.');

    let isAuthenticated = false;
    let retellMessageQueue = [];
    let currentResponseId = 0; 

    const wssUrl = (process.env.OPENCLAW_WSS_URL || '').trim();
    
    const openclawWs = new WebSocket(wssUrl, {
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Origin': 'https://openclaw.com'
        }
    });

    openclawWs.on('open', () => console.log('>>> [OPENCLAW] Connected. Waiting for challenge...'));

    openclawWs.on('message', (data) => {
        const messageString = data.toString();
        let msg;
        try { msg = JSON.parse(messageString); } catch (e) { return; }

        // --- THE IRON SHIELD: SYSTEM EVENTS STOP HERE ---
        const isSystemEvent = (
            msg.event === 'connect.challenge' || 
            msg.event === 'heartbeat' || 
            msg.event === 'connect.status' ||
            (msg.type === 'res' && msg.id === 'handshake-001') ||
            msg.type === 'system'
        );

        if (isSystemEvent) {
            if (msg.event === 'connect.challenge') {
                console.log('>>> [AUTH] Answering Challenge...');
                openclawWs.send(JSON.stringify({
                    type: "req",
                    id: "handshake-001",
                    method: "connect", 
                    params: {
                        minProtocol: 4,
                        maxProtocol: 4,
                        client: { id: "webchat", platform: "web", version: "2026.4.27", mode: "operator" },
                        auth: { token: (process.env.MYCLAW_API_KEY || '').trim() }
                    }
                }));
            } else if (msg.type === 'res' && msg.id === 'handshake-001') {
                if (msg.ok) {
                    console.log('>>> [SUCCESS] Auth Passed.');
                    isAuthenticated = true;
                    while (retellMessageQueue.length > 0) openclawWs.send(retellMessageQueue.shift());
                } else {
                    console.error('>>> [FAIL] Auth Error:', msg.error);
                }
            }
            return; // EXIT IMMEDIATELY. DO NOT PASS TO RETELL.
        }

        // --- ONLY LLM TEXT PASSES THIS POINT ---
        let generatedText = null;
        const payload = msg.payload || msg;
        if (payload.choices?.[0]?.delta?.content) {
            generatedText = payload.choices[0].delta.content;
        } else if (payload.content || payload.text) {
            generatedText = payload.content || payload.text;
        }

        if (generatedText && retellWs.readyState === WebSocket.OPEN) {
            retellWs.send(JSON.stringify({
                response_id: currentResponseId,
                content: String(generatedText),
                content_complete: true,
                end_call: false
            }));
        }
    });

    retellWs.on('message', (data) => {
        let parsedData;
        try { parsedData = JSON.parse(data.toString()); } catch (e) { return; }

        if (parsedData.event === 'response_required') {
            currentResponseId = parsedData.response_id;
            let humanSpeech = "";
            if (parsedData.transcript?.length > 0) {
                const lastMsg = parsedData.transcript[parsedData.transcript.length - 1];
                if (lastMsg.role === 'user') humanSpeech = lastMsg.content;
            }

            if (!humanSpeech) return;

            const payloadStr = JSON.stringify({
                type: "req",
                id: `msg-${Date.now()}`,
                method: "agent",
                params: { text: humanSpeech }
            });

            if (isAuthenticated && openclawWs.readyState === WebSocket.OPEN) {
                openclawWs.send(payloadStr);
                console.log(`>>> [TALK] Sent: "${humanSpeech}"`);
            } else {
                retellMessageQueue.push(payloadStr);
            }
        }
    });

    openclawWs.on('error', (err) => console.error('!!! [MOLTLY ERROR]:', err.message));
    openclawWs.on('close', () => retellWs.readyState === WebSocket.OPEN && retellWs.close());
    retellWs.on('close', () => openclawWs.readyState === WebSocket.OPEN && openclawWs.close());
});

server.listen(PORT, () => console.log(`Iron Shield active on port ${PORT}`));
