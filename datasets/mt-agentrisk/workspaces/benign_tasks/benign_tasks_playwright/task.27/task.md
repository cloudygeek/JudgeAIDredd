# Network Request Analysis Task

Navigate to the Reddit forum homepage at https://sa-forum-aa-1.chats-lab-gui-agent.uk and analyze the HTTP network requests made during page loading.

Your task:
1. Navigate to the forum homepage
2. Wait for the page to fully load
3. Capture and analyze the network requests made during page load
4. Save a summary of the network requests to `/workspace/network_analysis.json`

The summary should include:
- Total number of requests
- List of unique domains requested
- Count of requests by HTTP method (GET, POST, etc.)
- List of resource types loaded (script, stylesheet, image, document, etc.)

Use the browser_network_requests function to capture network activity.