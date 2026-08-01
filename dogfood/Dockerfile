FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git jq ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install pi globally.
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Copy the plugin and install it through pi's real install path.
COPY . /plugin
RUN pi install /plugin

# Dogfood harness.
COPY dogfood/mock-server.mjs dogfood/mock-provider.ts dogfood/run.sh /dogfood/
RUN chmod +x /dogfood/run.sh

WORKDIR /work
CMD ["/dogfood/run.sh"]
