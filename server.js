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

    // Bypass WAF with Origin and User-Agent headers
    const openclawWs = new WebSocket(process.env.OPENCLAW_WSS_URL, {
        headers: { 
            'User-Agent': 'Node.js/365Digital-Proxy',
            'Origin': process.env.OPENCLAW_WSS_URL.replace('wss://', 'https://').replace('ws://', 'http://')
        }
    });

    openclawWs.on('open', () => {
        console.log('>>> OpenClaw connection open. Waiting for challenge...');
    });

    openclawWs.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }

        // 1. PERFECT HANDSHAKE RESPONSE
        if (msg.event === 'connect.challenge') {
            console.log('<<< Received connect.challenge. Sending properly formatted req frame...');
            
            // OpenClaw Gateway Protocol strictly requires 'type' and 'id'
            const authPayload = {
                type: "req",
                id: "handshake-001",
                method: "connect", 
                params: {
                    client: { id: "365digital-proxy", platform: "node" },
                    auth: { token: (process.env.MYCLAW_API_KEY || '').trim() }
                }
            };
            openclawWs.send(JSON.stringify(authPayload));
            return; 
        }

        // 2. HANDSHAKE SUCCESS CHECK
        if (msg.type === 'res' && msg.id === 'handshake-001') {
            if (msg.ok) {
                console.log('>>> Authentication successful! Opening the pipeline.');
                isAuthenticated = true;
                
                // Release any audio events Retell queued up during the handshake
                while (retellMessageQueue.length > 0) {
                    openclawWs.send(retellMessageQueue.shift());
                }
            } else {
                console.error('>>> Authentication Failed:', msg.error);
            }
            return;
        }

        // 3. SILENCE SYSTEM NOISE
        if (msg.event === 'heartbeat' || msg.type === 'system') return;

        // 4. OPENCLAW -> RETELL TRANSLATION LAYER
        let generatedText = null;
        const payload = msg.payload || msg; // OpenClaw nests event data inside 'payload'

        if (payload.choices && payload.choices.length > 0) {
            generatedText = payload.choices[0].message?.content || payload.choices[0].delta?.content;
        } else if (payload.response !== undefined) {
            generatedText = payload.response;
        } else if (payload.content !== undefined) {
            generatedText = payload.content;
        } else if (payload.text !== undefined) {
            generatedText = payload.text;
        } else if (typeof payload === 'string') {
            generatedText = payload;
        }

        // Format for Retell and send
        if (generatedText) {
            const retellResponse = {
                response_id: currentResponseId,
                content: generatedText,
                content_complete: true,
                end_call: false
            };
            if (retellWs.readyState === WebSocket.OPEN) {
                retellWs.send(JSON.stringify(retellResponse));
                console.log(`>>> Sent to Retell: "${generatedText.substring(0, 50)}..."`);
            }
        }
    });

    openclawWs.on('error', (err) => console.error('OpenClaw error:', err.message));
    openclawWs.on('close', (code, reason) => {
        console.log(`OpenClaw closed: ${code} ${reason}`);
        if (retellWs.readyState === WebSocket.OPEN) retellWs.close();
    });

    // --- RETELL -> OPENCLAW TRANSLATION LAYER ---
    retellWs.on('message', (data) => {
        let parsedData;
        try { parsedData = JSON.parse(data.toString()); } catch (e) { return; }

        if (parsedData.event === 'response_required') {
            currentResponseId = parsedData.response_id;
            
            // Extract the human speech from Retell's transcript array
            let humanSpeech = "";
            if (parsedData.transcript && parsedData.transcript.length > 0) {
                const lastMsg = parsedData.transcript[parsedData.transcript.length - 1];
                if (lastMsg.role === 'user') humanSpeech = lastMsg.content;
            }

            if (!humanSpeech) return;

            // Translate into an OpenClaw Gateway "Agent" Request
            const openclawReq = {
                type: "req",
                id: `msg-${Date.now()}`,
                method: "agent",
                params: {
                    text: humanSpeech
                }
            };

            const payloadStr = JSON.stringify(openclawReq);

            if (isAuthenticated && openclawWs.readyState === WebSocket.OPEN) {
                openclawWs.send(payloadStr);
                console.log(`>>> Sent Human Speech to OpenClaw: "${humanSpeech}"`);
            } else {
                retellMessageQueue.push(payloadStr);
            }
        }
    });

    retellWs.on('close', () => {
        console.log('Retell AI disconnected');
        if (openclawWs.readyState === WebSocket.OPEN) openclawWs.close();
    });
});

server.listen(PORT, () => console.log(`WebSocket Server listening on port ${PORT}`));
