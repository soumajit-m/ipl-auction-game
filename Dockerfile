FROM node:20-slim

WORKDIR /app

# Copy package definitions
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application code
COPY . .

# Build Next.js production bundle
RUN npm run build

# Default Hugging Face Spaces port
ENV PORT=7860
ENV NODE_ENV=production
EXPOSE 7860

# Start unified Next.js + Socket.io server
CMD ["npm", "start"]
