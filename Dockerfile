FROM docker:24-dind

RUN apk add --no-cache nodejs npm git

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]