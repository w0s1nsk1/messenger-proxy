# Use Playwright base image to include browsers and dependencies
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Install dependencies based on lockfile for reproducible builds
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY src ./src
COPY message.html ./
COPY storage ./storage

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]
