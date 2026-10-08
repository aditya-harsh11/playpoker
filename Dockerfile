# One image runs any of the game servers (SERVER_ID picks its name).

# --- build: install everything and build the client --------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared shared
COPY client client
RUN npm run build

# --- run: production dependencies + server source + built client -------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force
COPY shared shared
COPY server server
COPY --from=build /app/client/dist client/dist
USER node
EXPOSE 3001
CMD ["npm", "start"]
