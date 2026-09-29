FROM node:18-alpine

RUN apk add --no-cache git python3 make g++ openjdk17-jdk maven

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]