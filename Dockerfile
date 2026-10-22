# One small container: Node + FFmpeg + the app. No database, no object storage.
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY assets ./assets
ENV PORT=8080 JOB_TTL_HOURS=6
EXPOSE 8080
USER node
CMD ["node", "server.js"]
