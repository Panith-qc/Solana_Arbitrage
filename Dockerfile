# Use Node.js Alpine for smaller image
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install serve globally to serve static files
RUN npm install -g serve

# Copy built assets from builder
COPY --from=builder /app/dist ./dist

# Set environment variables
ENV PORT=5173
ENV NODE_ENV=production

# Expose port
EXPOSE 5173

# Serve the pre-built application
CMD ["serve", "-s", "dist", "-l", "5173", "--no-clipboard"]
