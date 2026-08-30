ARG NODE_IMAGE=node:18-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates pciutils \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY agent.mjs ./

CMD ["node", "agent.mjs"]
