const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const PORT = process.env.PORT || 10000;

// Render Health Check & Identity Proof
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200);
        res.end('VERIFIED: THE NUCLEAR SILENCER IS ACTIVE.'); 
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

    // FUNCTION: The Handshake Disguise
    const sendHandshake = () => {
        console.log('>>> [AUTH] Sending Handshake...');
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
    };

    openclawWs.on('open', () => {
        console.log('>>> [OPENCLAW] Connected. Pre-authenticating...');
        sendHandshake(); // Pre-emptive strike
    });

    openclawWs.on('message', (data) => {
        const rawString = data.toString();

        // --- THE NUCLEAR SILENCER ---
        // If the raw text contains ANY system keywords, kill it immediately.
        // This prevents Retell from seeing "challenge" and crashing.
        if (
            rawString.includes("challenge") || 
            rawString.includes("handshake") || 
            rawString.includes("heartbeat") || 
            rawString.includes("system") ||
            rawString.includes("connect.status")
        ) {
            console.log('>>> [SILENCED] Blocked system noise from Retell.');
            
            try {
                const msg = JSON.parse(rawString);
                if (msg.event === 'connect.challenge') {
                    sendHandshake(); // Respond to challenge if it appeared
                } else if (msg.type === 'res' && msg.id === 'handshake-001' && msg.ok) {
                    console.log('>>> [SUCCESS] Auth Finalized.');
                    isAuthenticated = true;
                    while (retellMessageQueue.length > 0) openclawWs.send(retellMessageQueue.shift());
                }
            } catch (e) {}
            return; // ABSOLUTE STOP. DO NOT PROCEED TO RETELL SENDING LOGIC.
        }

        // --- LLM TEXT TRANSLATION ---
        let msg;
        try { msg = JSON.parse(rawString); } catch (e) { return; }

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
                console.log('>>> [QUEUE] Holding speech until auth finishes...');
                retellMessageQueue.push(payloadStr);
            }
        }
    });

    openclawWs.on('error', (err) => console.error('!!! [MOLTLY ERROR]:', err.message));
    openclawWs.on('close', () => retellWs.readyState === WebSocket.OPEN && retellWs.close());
    retellWs.on('close', () => openclawWs.readyState === WebSocket.OPEN && openclawWs.close());
});

server.listen(PORT, () => console.log(`Nuclear Silencer active on port ${PORT}`));
