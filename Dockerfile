FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Hugging Face Spaces runs the container as uid 1000, which is the node user.
RUN mkdir -p runs && chown -R node:node /app
USER node

ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
