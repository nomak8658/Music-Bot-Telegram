FROM node:20-slim

# Install Python 3 + ffmpeg + build tools
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-dev \
    ffmpeg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package.json ./
RUN npm install

# Copy source and build
COPY . .
RUN node ./build.mjs

# Install Python dependencies
RUN pip3 install --no-cache-dir --break-system-packages \
    telethon \
    py-tgcalls \
    yt-dlp \
    aiohttp

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
