const app = require('./app');

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`EvenFlow server listening on port ${PORT}`);
});
