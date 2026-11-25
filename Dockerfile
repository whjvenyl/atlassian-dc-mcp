# --- build ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` would run `npm run build` before sources exist
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S mcp && adduser -S mcp -G mcp
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json policy.example.yaml ./
USER mcp
EXPOSE 3000
# Mount your policy at /app/policy.yaml (default POLICY_PATH)
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["node", "dist/index.js"]
