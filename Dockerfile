# Use Node.js Alpine for smaller image
FROM node:20-alpine

WORKDIR /app

# Install serve globally to serve static files
RUN npm install -g serve

# Copy only the pre-built dist folder
COPY dist ./dist

# Set environment variables
ENV PORT=8080
ENV NODE_ENV=production

# Expose port
EXPOSE 8080

# Serve the pre-built application
CMD ["serve", "-s", "dist", "-l", "8080", "--no-clipboard"]
