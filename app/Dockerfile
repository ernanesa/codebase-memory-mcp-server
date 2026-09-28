FROM node:26-alpine

RUN apk add --no-cache ca-certificates git openssh-client

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY proto ./proto

ENV NODE_ENV=production PORT=3000
EXPOSE 3000 3001

CMD ["node", "src/server.js"]
