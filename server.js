const { app, startServer } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);

startServer(PORT);
