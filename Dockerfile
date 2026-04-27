FROM node:20-slim

# Install Python 3.11 + ffmpeg + build tools
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-dev \
    ffmpeg \
    curl \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy workspace files
COPY package.json pnpm-workspace.yaml ./
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Install Node dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY . .

# Install Python dependencies
RUN pip3 install --no-cache-dir \
    telethon \
    py-tgcalls \
    yt-dlp \
    aiohttp

# Build the TypeScript bot
RUN pnpm --filter @workspace/api-server run build

# Set working directory to the api-server
WORKDIR /app/artifacts/api-server

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
