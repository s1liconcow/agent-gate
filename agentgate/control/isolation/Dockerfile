FROM node:24-bookworm-slim
WORKDIR /opt/agentgate
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install -g @openai/codex @anthropic-ai/claude-code
COPY mcp ./mcp
COPY isolation/agent-entry.mjs ./agent-entry.mjs
RUN mkdir -p /work && chown node:node /work
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/agentgate/agent-entry.mjs"]
