FROM node:18-alpine
WORKDIR /app
RUN apk add --no-cache git python3 make g++ openjdk17-jdk maven