FROM node:20-slim

WORKDIR /app

# Copy only what you need - skip all dependencies
COPY dist ./dist
COPY server.js ./
COPY package.json ./

# Only install the 3 runtime deps server.js needs
RUN npm install --only=production \
    express@^4.21.0 \
    cors@^2.8.5 \
    bs58@^6.0.0

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
