# Security

Please report vulnerabilities privately to info@alkapa.com, not in a public issue. You'll get an
answer within a few days.

What the agent guards:
- the sign-in (`credentials.json`, an OAuth refresh token): stored with owner-only permissions;
- the owner's machine: the agent runs only offered models and calls only Ollama's chat, tags,
  ps and version endpoints; nothing from the server is ever executed;
- users' data: prompts, answers and images are never logged or stored.
