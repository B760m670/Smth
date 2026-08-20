# One image: builds the client, then serves it and owns the WebSocket on the
# same port. One service to deploy, one URL, and `wss://` works because the
# page and its socket are same-origin behind whatever terminates TLS.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# ws is the only runtime dependency the server has; three ships inside the
# client bundle the build step already produced.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY shared ./shared
COPY server ./server
EXPOSE 8080
ENV PORT=8080
ENV BOTS=2
# Node 22 executes TypeScript directly — nothing to transpile for the server.
CMD ["node", "server/main.ts"]
