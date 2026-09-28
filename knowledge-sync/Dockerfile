FROM node:26-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production PORT=3002
EXPOSE 3002

CMD ["node", "src/server.js"]
