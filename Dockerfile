FROM node:20-alpine

WORKDIR /app

# Copy project files
COPY package.json ./
COPY server ./server
COPY public ./public
COPY test ./test

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server/index.js"]
