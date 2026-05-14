const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

// Configuration
const PORT = process.env.PORT || 8080;
const OPENCLAW_WSS_URL = process.env.OPENCLAW_WSS_URL || 'wss://api.openclaw.com/ws';
const MYCLAW_API_KEY = process.env.MYCLAW_API_KEY || 'your_myclaw_api_key';

// Create a basic HTTP server to handle health checks (required by some hosting platforms like Render)
const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Retell AI - OpenClaw Proxy Server is running.');
    } else {
        res.writeHead(404);
        res.end();
    }
});

// Initialize WebSocket server attached to the HTTP server
const wss = new WebSocketServer({ server });

wss.on('connection', (retellWs) => {
    console.log('Retell AI connected via WebSocket');

    let currentResponseId = null;
    let isOpenClawAuthenticated = false;

    // Clean variables to prevent header breaking
    const cleanUrl = OPENCLAW_WSS_URL.trim();
    const cleanApiKey = MYCLAW_API_KEY.trim();

    // Connect to OpenClaw WS as a client
    console.log(`Connecting to OpenClaw WS at ${cleanUrl}...`);
    
    // Using explicit options to prevent ws subprotocol parsing issues
    const openclawWs = new WebSocket(cleanUrl, [], {
        headers: {
            'user-agent': 'Node.js/365Digital-Proxy'
        }
    });

    // 1. Do NOT send anything immediately on the ws.on('open') event.
    openclawWs.on('open', () => {
        console.log('Successfully connected to OpenClaw WebSocket. Waiting for connect.challenge...');
    });

    // 2. Listen to incoming messages from OpenClaw for the challenge
    openclawWs.on('message', (data) => {
        try {
            const rawResponse = data.toString();
            let openClawData;
            
            try {
                openClawData = JSON.parse(rawResponse);
            } catch (e) {
                // If it's not JSON, skip parsing
                return;
            }

            // Challenge-Response Handshake
            if (openClawData.event === 'connect.challenge') {
                console.log('Received connect.challenge from OpenClaw! Sending auth response...');
                
                const connectResponse = {
                    method: "connect",
                    params: {
                        auth: {
                            token: cleanApiKey
                        }
                    }
                };
                
                openclawWs.send(JSON.stringify(connectResponse));
                isOpenClawAuthenticated = true;
                console.log('Authentication frame sent! Proxy is now open for Retell events.');
                return;
            }

            // Handling actual LLM responses after authentication
            let generatedText = "";
            if (openClawData.choices && openClawData.choices.length > 0) {
                 generatedText = openClawData.choices[0].message?.content || openClawData.choices[0].delta?.content || "";
            } else if (openClawData.response) {
                 generatedText = openClawData.response;
            } else if (openClawData.content) {
                 generatedText = openClawData.content;
            }

            if (currentResponseId !== null && generatedText.trim()) {
                const retellResponse = {
                    response_id: currentResponseId,
                    content: generatedText,
                    content_complete: true,
                    end_call: false
                };

                retellWs.send(JSON.stringify(retellResponse));
                console.log('Sent generated text response back to Retell.');
            }
        } catch (error) {
            console.error('Error handling OpenClaw message:', error);
        }
    });

    openclawWs.on('error', (error) => {
        console.error('OpenClaw WebSocket error:', error.message || error);
    });

    openclawWs.on('close', (code, reason) => {
        console.log(`OpenClaw WebSocket closed: Code ${code}, Reason: ${reason}`);
    });

    // Listen for messages from Retell
    retellWs.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            if (message.event && message.event !== 'media') { // Ignore media spam in logs
                 console.log('Received event from Retell:', message.event);
            }

            // 3. Only after sending this specific connect frame should the proxy start forwarding
            if (!isOpenClawAuthenticated) {
                console.log('OpenClaw not yet authenticated. Holding off on forwarding Retell event.');
                return;
            }

            // Process response_required events to get the transcript
            if (message.event === 'response_required') {
                currentResponseId = message.response_id;
                
                let latestUserText = '';
                
                if (message.transcript && Array.isArray(message.transcript)) {
                    const userUtterances = message.transcript.filter(t => t.role === 'user');
                    if (userUtterances.length > 0) {
                        latestUserText = userUtterances[userUtterances.length - 1].content;
                    }
                }

                // Fallback direct utterance
                if (!latestUserText && message.utterance) {
                    latestUserText = message.utterance;
                }

                console.log(`Extracted user text: "${latestUserText}"`);

                if (!latestUserText) {
                    console.log("No user text extracted, skipping OpenClaw request.");
                    return;
                }

                // Send text string to OpenClaw WebSocket
                if (openclawWs.readyState === WebSocket.OPEN) {
                    console.log('Forwarding extracted text to OpenClaw WS...');
                    openclawWs.send(JSON.stringify({
                        messages: [
                            { role: 'user', content: latestUserText }
                        ]
                    }));
                } else {
                    console.error('OpenClaw WS is not open. Ready state:', openclawWs.readyState);
                    retellWs.send(JSON.stringify({
                        response_id: currentResponseId,
                        content: "I'm having trouble connecting to my brain right now.",
                        content_complete: true,
                        end_call: false
                    }));
                }
            }

        } catch (error) {
            console.error('Error parsing WebSocket message:', error.message);
        }
    });

    retellWs.on('close', () => {
        console.log('Retell AI disconnected');
        if (openclawWs.readyState === WebSocket.OPEN) {
            openclawWs.close(); // Clean up the connection to OpenClaw
        }
    });
    
    retellWs.on('error', (error) => {
        console.error('Retell WebSocket error:', error);
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`WebSocket Server listening on port ${PORT}`);
    console.log(`Health check available at http://localhost:${PORT}/health`);
});
