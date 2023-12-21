FROM node

ARG PORT=3000
ENV PORT=$PORT

COPY . .

EXPOSE PORT

CMD ["npm", "run", "dashboard"]
