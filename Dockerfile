# Specify the base Docker image.
# This actor is API-first (no browser required), so use the smaller Node.js base image.
FROM apify/actor-node:22

# Copy just package.json and package-lock.json (if present) to speed up the build using Docker layer cache.
COPY --chown=myuser:myuser package*.json Dockerfile ./

# Install NPM packages, skip optional and development dependencies to
# keep the image small. Avoid logging too much and print the dependency
# tree for debugging
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --no-audit --no-fund \
    && rm -r ~/.npm

# Next, copy the remaining files and directories with the source code.
# Since we do this after NPM install, quick build will be really fast
# for most source file changes.
COPY --chown=myuser:myuser . ./

CMD npm start --silent
