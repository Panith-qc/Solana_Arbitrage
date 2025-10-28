FROM node:20-slim

WORKDIR /app

COPY dist ./dist
COPY server.js ./
COPY package.json ./

RUN npm install express cors bs58

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
