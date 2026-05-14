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

    // Connect to OpenClaw WS as a client
    console.log(`Connecting to OpenClaw WS at ${OPENCLAW_WSS_URL}...`);
    const openclawWs = new WebSocket(OPENCLAW_WSS_URL, {
        headers: {
            'User-Agent': 'Node.js/365Digital-Proxy',
            'Authorization': `Bearer ${MYCLAW_API_KEY}`
        }
    });

    openclawWs.on('open', () => {
        console.log('Successfully connected to OpenClaw WebSocket');
    });

    openclawWs.on('message', (data) => {
        try {
            const rawResponse = data.toString();
            console.log('Received message from OpenClaw WS:', rawResponse);
            
            let generatedText = rawResponse; // Default to raw string if not JSON
            try {
                const openClawData = JSON.parse(rawResponse);
                // Try multiple common JSON formats to extract generated text
                if (openClawData.choices && openClawData.choices.length > 0) {
                     generatedText = openClawData.choices[0].message?.content || openClawData.choices[0].delta?.content || "";
                } else if (openClawData.response) {
                     generatedText = openClawData.response;
                } else if (openClawData.content) {
                     generatedText = openClawData.content;
                }
            } catch (e) {
                // Could not parse as JSON, keeping it as raw string
            }

            if (currentResponseId !== null && generatedText.trim()) {
                const retellResponse = {
                    response_id: currentResponseId,
                    content: generatedText,
                    content_complete: true, // adjust if OpenClaw actually streams tokens
                    end_call: false
                };

                retellWs.send(JSON.stringify(retellResponse));
                console.log('Sent response back to Retell.');
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
            
            // Log the event type without spamming transcripts
            if (message.event) {
                 console.log('Received event from Retell:', message.event);
            }

            // 1. Listen for response_required event
            if (message.event === 'response_required') {
                currentResponseId = message.response_id;
                
                // 2. Extract the latest user transcript
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

                // 3. Send text string to OpenClaw WebSocket
                if (openclawWs.readyState === WebSocket.OPEN) {
                    console.log('Sending text to OpenClaw WS...');
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
