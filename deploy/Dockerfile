FROM node:20-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-dev \
    ffmpeg \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN node ./build.mjs

# CACHEBUST only affects pip layer — npm layer stays cached
ARG CACHEBUST=2026-04-27-v5
RUN pip3 install --no-cache-dir --break-system-packages \
    telethon \
    py-tgcalls \
    aiohttp && \
    pip3 install --no-cache-dir --break-system-packages --upgrade yt-dlp

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
