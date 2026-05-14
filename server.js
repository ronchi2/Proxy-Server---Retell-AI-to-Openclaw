"I need you to rewrite the server.js WebSocket proxy logic that connects to OpenClaw. We are hitting a WAF block (ua=n/a) and failing the OpenClaw challenge-response authentication.

Rewrite the code to follow this EXACT strict sequence. Do not deviate or strip out any of these steps:

Step 1: The Initial Connection (Bypass the WAF)
When initializing the new WebSocket(process.env.OPENCLAW_WSS_URL), you MUST include the headers object as the second argument, passing a valid User-Agent.
Example: { headers: { 'User-Agent': 'Node.js/365Digital-Proxy' } }

Step 2: The Silent Open
On the ws.on('open') event, do NOT send any authentication tokens. Log that the connection is open, but wait silently.

Step 3: The Challenge-Response Handshake
Listen to incoming messages from OpenClaw. Parse the incoming JSON.
If the parsed message has event === 'connect.challenge', you must immediately send back this EXACT JSON structure to authenticate:
{"method": "connect", "params": {"auth": {"token": process.env.MYCLAW_API_KEY}}}

Step 4: The Audio Pipeline
Only after the challenge has been successfully answered should the proxy begin routing the audio JSON payloads from Retell AI to OpenClaw, and vice versa.

Give me the complete, updated server.js code."
