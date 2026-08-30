FROM node:18-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY agent.mjs ./

CMD ["node", "agent.mjs", "--help"]
