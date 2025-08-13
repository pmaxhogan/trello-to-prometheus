FROM node:lts-slim

# Overridden by the user
ENV TRELLO_KEY="" \
    TRELLO_TOKEN="" \
    TRELLO_BOARD_ID="" \
    PORT="" \
    API_TOKEN=""

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE ${PORT:-3000}
CMD ["node", "index.js"]
