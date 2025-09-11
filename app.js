// app.js
const { app } = require('./express_sqlite_cache'); // Import Express app from your main file

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('Try these endpoints:');
  console.log(`  GET  http://localhost:${PORT}/api/users`);
  console.log(`  GET  http://localhost:${PORT}/api/users/1`);
  console.log(`  GET  http://localhost:${PORT}/api/posts`);
  console.log(`  GET  http://localhost:${PORT}/api/expensive`);
  console.log(`  GET  http://localhost:${PORT}/api/cache/stats`);
  console.log('Use below endpoint to clear all cache:');
  console.log(`  DELETE  curl -X DELETE http://localhost:${PORT}/api/cache`);
});
