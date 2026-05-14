const { WebSocketServer } = require('ws');
const http = require('http');

// Configuration
const PORT = process.env.PORT || 8080;
// You can set your OpenClaw endpoint in environment variables, or it defaults to a standard generic endpoint.
const OPENCLAW_API_URL = process.env.OPENCLAW_API_URL || 'https://api.openclaw.com/v1/chat/completions';
const OPENCLAW_API_KEY = process.env.OPENCLAW_API_KEY || 'your_openclaw_api_key';

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

wss.on('connection', (ws) => {
    console.log('Retell AI connected via WebSocket');

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString());
            
            // Log the event type, avoiding spamming the console with full transcripts
            if (message.event) {
                 console.log('Received event from Retell:', message.event);
            }

            // 1. Listen for response_required event
            if (message.event === 'response_required') {
                const responseId = message.response_id;
                
                // 2. Extract the latest user transcript
                let latestUserText = '';
                
                // Retell sends the transcript as an array of messages
                if (message.transcript && Array.isArray(message.transcript)) {
                    const userUtterances = message.transcript.filter(t => t.role === 'user');
                    if (userUtterances.length > 0) {
                        // Get the most recent user message
                        latestUserText = userUtterances[userUtterances.length - 1].content;
                    }
                }

                // If no transcript structure is present, check for direct utterance (fallback)
                if (!latestUserText && message.utterance) {
                    latestUserText = message.utterance;
                }

                console.log(`Extracted user text: "${latestUserText}"`);

                if (!latestUserText) {
                    console.log("No user text extracted, skipping OpenClaw request.");
                    return;
                }

                // 3. Send text string to OpenClaw REST API endpoint
                try {
                    console.log('Sending request to OpenClaw...');
                    const openClawResponse = await fetch(OPENCLAW_API_URL, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${OPENCLAW_API_KEY}`
                        },
                        body: JSON.stringify({
                            messages: [
                                { role: 'user', content: latestUserText }
                            ]
                        })
                    });

                    if (!openClawResponse.ok) {
                        const errorText = await openClawResponse.text();
                        throw new Error(`OpenClaw API error (${openClawResponse.status}): ${errorText}`);
                    }

                    // 4. Wait for OpenClaw to return its generated text response
                    const openClawData = await openClawResponse.json();
                    
                    // Extract text (assuming OpenAI-compatible schema standard)
                    let generatedText = "Sorry, I couldn't generate a response.";
                    if (openClawData.choices && openClawData.choices.length > 0) {
                         generatedText = openClawData.choices[0].message.content;
                    } else if (openClawData.response) { // Generic fallback
                         generatedText = openClawData.response;
                    }

                    console.log(`OpenClaw response: "${generatedText}"`);

                    // 5. Package text response into Retell's JSON schema and send back
                    const retellResponse = {
                        response_id: responseId,
                        content: generatedText,
                        content_complete: true,
                        end_call: false
                    };

                    ws.send(JSON.stringify(retellResponse));
                    console.log('Sent response back to Retell.');

                } catch (apiError) {
                    console.error('Error calling OpenClaw:', apiError.message);
                    
                    // Send error fallback back to Retell
                    ws.send(JSON.stringify({
                        response_id: responseId,
                        content: "I'm having a little trouble thinking right now.",
                        content_complete: true,
                        end_call: false
                    }));
                }
            }

        } catch (error) {
            console.error('Error parsing WebSocket message:', error.message);
        }
    });

    ws.on('close', () => {
        console.log('Retell AI disconnected');
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`WebSocket Server listening on port ${PORT}`);
    console.log(`Health check available at http://localhost:${PORT}/health`);
});
