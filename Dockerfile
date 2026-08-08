FROM node:20-alpine

# Install better-sqlite3 native dependencies
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/upi-demo.db
# Suppress dotenvx informational tips in logs
ENV DOTENVX_TIP_DISABLED=true

CMD ["node", "src/server.js"]
