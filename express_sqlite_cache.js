const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// SQLite Cache Class
class SQLiteCache {
  constructor(dbPath = ':memory:', options = {}) {
    this.dbPath = dbPath;
    this.defaultTTL = options.defaultTTL || 3600;
    this.cleanupInterval = options.cleanupInterval || 300000;
    this.db = null;
    this.cleanupTimer = null;
    this.statements = {};
  }

  init() {
    try {
      if (this.dbPath !== ':memory:') {
        const dir = path.dirname(this.dbPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      this.db = new DatabaseSync(this.dbPath);

      if (this.dbPath !== ':memory:') {
        this.db.exec('PRAGMA journal_mode = WAL');
      }

      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          accessed_at INTEGER DEFAULT (unixepoch()),
          hit_count INTEGER DEFAULT 1
        )
      `;

      this.db.exec(createTableSQL);
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_expires_at ON cache(expires_at)');
      this.prepareStatements();
      this.startCleanup();
      return true;
    } catch (error) {
      throw new Error(`Failed to initialize cache: ${error.message}`);
    }
  }

  prepareStatements() {
    this.statements = {
      set: this.db.prepare(`
        INSERT OR REPLACE INTO cache (key, value, expires_at, accessed_at, hit_count) 
        VALUES (?, ?, ?, unixepoch(), 1)
      `),
      
      get: this.db.prepare(`
        SELECT value, expires_at, hit_count FROM cache 
        WHERE key = ? AND expires_at > unixepoch()
      `),
      
      updateAccess: this.db.prepare(`
        UPDATE cache SET accessed_at = unixepoch(), hit_count = hit_count + 1 
        WHERE key = ?
      `),
      
      delete: this.db.prepare('DELETE FROM cache WHERE key = ?'),
      has: this.db.prepare('SELECT 1 FROM cache WHERE key = ? AND expires_at > unixepoch()'),
      clear: this.db.prepare('DELETE FROM cache'),
      cleanup: this.db.prepare('DELETE FROM cache WHERE expires_at <= unixepoch()'),
      
      stats: this.db.prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN expires_at > unixepoch() THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN expires_at <= unixepoch() THEN 1 ELSE 0 END) as expired,
          AVG(LENGTH(value)) as avg_size,
          SUM(hit_count) as total_hits
        FROM cache
      `),

      getAll: this.db.prepare(`
        SELECT key, value, expires_at, created_at, accessed_at, hit_count
        FROM cache 
        WHERE expires_at > unixepoch()
        ORDER BY accessed_at DESC
        LIMIT ?
      `)
    };
  }

  set(key, value, ttl = null) {
    if (!this.db) throw new Error('Cache not initialized');
    
    try {
      const actualTTL = ttl || this.defaultTTL;
      const expiresAt = Math.floor(Date.now() / 1000) + actualTTL;
      const serializedValue = JSON.stringify(value);
      this.statements.set.run(key, serializedValue, expiresAt);
      return true;
    } catch (error) {
      throw new Error(`Failed to set cache: ${error.message}`);
    }
  }

  get(key) {
    if (!this.db) throw new Error('Cache not initialized');
    
    try {
      const row = this.statements.get.get(key);
      if (!row) return null;
      
      this.statements.updateAccess.run(key);
      return JSON.parse(row.value);
    } catch (error) {
      throw new Error(`Failed to get cache: ${error.message}`);
    }
  }

  delete(key) {
    if (!this.db) throw new Error('Cache not initialized');
    
    try {
      const result = this.statements.delete.run(key);
      return result.changes > 0;
    } catch (error) {
      throw new Error(`Failed to delete cache: ${error.message}`);
    }
  }

  has(key) {
    if (!this.db) throw new Error('Cache not initialized');
    
    try {
      const row = this.statements.has.get(key);
      return !!row;
    } catch (error) {
      throw new Error(`Failed to check cache: ${error.message}`);
    }
  }

  clear() {
    if (!this.db) throw new Error('Cache not initialized');
    
    try {
      this.statements.clear.run();
      return true;
    } catch (error) {
      throw new Error(`Failed to clear cache: ${error.message}`);
    }
  }

  stats() {
    if (!this.db) throw new Error('Cache not initialized');
    
    try {
      const stats = this.statements.stats.get();
      return {
        total: stats.total || 0,
        active: stats.active || 0,
        expired: stats.expired || 0,
        avg_size: Math.round(stats.avg_size || 0),
        total_hits: stats.total_hits || 0,
        hit_rate: stats.total > 0 ? ((stats.total_hits || 0) / stats.total).toFixed(2) : '0.00'
      };
    } catch (error) {
      throw new Error(`Failed to get stats: ${error.message}`);
    }
  }

  getAllEntries(limit = 50) {
    if (!this.db) throw new Error('Cache not initialized');
    
    try {
      const rows = this.statements.getAll.all(limit);
      return rows.map(row => ({
        key: row.key,
        value: JSON.parse(row.value),
        expires_at: new Date(row.expires_at * 1000),
        created_at: new Date(row.created_at * 1000),
        accessed_at: new Date(row.accessed_at * 1000),
        hit_count: row.hit_count
      }));
    } catch (error) {
      throw new Error(`Failed to get all entries: ${error.message}`);
    }
  }

  cleanup() {
    if (!this.db) return 0;
    
    try {
      const result = this.statements.cleanup.run();
      return result.changes;
    } catch (error) {
      throw new Error(`Cleanup failed: ${error.message}`);
    }
  }

  startCleanup() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    
    this.cleanupTimer = setInterval(() => {
      try {
        const cleaned = this.cleanup();
        if (cleaned > 0) {
          console.log(`Cache cleanup: removed ${cleaned} expired entries`);
        }
      } catch (error) {
        console.error('Cache cleanup error:', error.message);
      }
    }, this.cleanupInterval);
  }

  close() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    if (this.db) {
      Object.values(this.statements).forEach(stmt => {
        if (stmt && typeof stmt.finalize === 'function') {
          stmt.finalize();
        }
      });
      this.db.close();
      this.db = null;
    }
  }

  static generateKey(input) {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return crypto.createHash('md5').update(str).digest('hex');
  }
}

// Express Cache Middleware
function createCacheMiddleware(cache, options = {}) {
  const {
    keyGenerator = (req) => `${req.method}:${req.originalUrl}`,
    ttl = 300, // 5 minutes default
    condition = () => true,
    skipSuccessful = false
  } = options;

  return (req, res, next) => {
    // Skip caching for certain conditions
    if (!condition(req) || req.method !== 'GET') {
      return next();
    }

    const cacheKey = keyGenerator(req);
    
    try {
      // Try to get from cache
      const cached = cache.get(cacheKey);
      if (cached) {
        res.set('X-Cache-Hit', 'true');
        res.set('X-Cache-Key', cacheKey);
        return res.json(cached);
      }

      // Cache miss - intercept response
      const originalSend = res.send;
      const originalJson = res.json;
      
      res.send = function(data) {
        res.send = originalSend;
        res.json = originalJson;
        
        // Cache successful responses
        if (!skipSuccessful && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsedData = typeof data === 'string' ? JSON.parse(data) : data;
            cache.set(cacheKey, parsedData, ttl);
            res.set('X-Cache-Hit', 'false');
            res.set('X-Cache-Key', cacheKey);
          } catch (error) {
            console.error('Failed to cache response:', error.message);
          }
        }
        
        return originalSend.call(this, data);
      };

      res.json = function(data) {
        res.send = originalSend;
        res.json = originalJson;
        
        // Cache successful JSON responses
        if (!skipSuccessful && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            cache.set(cacheKey, data, ttl);
            res.set('X-Cache-Hit', 'false');
            res.set('X-Cache-Key', cacheKey);
          } catch (error) {
            console.error('Failed to cache response:', error.message);
          }
        }
        
        return originalJson.call(this, data);
      };

      next();
    } catch (error) {
      console.error('Cache middleware error:', error.message);
      next();
    }
  };
}

// Express Application
const app = express();
app.use(express.json());

// Initialize cache
const cache = new SQLiteCache('./cache/express-cache.db', {
  defaultTTL: 3600, // 1 hour
  cleanupInterval: 60000 // 1 minute
});

// Initialize cache on startup
try {
  cache.init();
  console.log('Cache initialized successfully');
} catch (error) {
  console.error('Failed to initialize cache:', error.message);
  process.exit(1);
}

// Cache middleware for API routes
const apiCache = createCacheMiddleware(cache, {
  ttl: 600, // 10 minutes for API responses
  keyGenerator: (req) => `api:${req.method}:${req.path}:${JSON.stringify(req.query)}`,
  condition: (req) => !req.headers['cache-control']?.includes('no-cache')
});

// Simulate database or external API calls
const mockDatabase = {
  users: [
    { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' },
    { id: 2, name: 'Jane Smith', email: 'jane@example.com', role: 'user' },
    { id: 3, name: 'Bob Johnson', email: 'bob@example.com', role: 'user' }
  ],
  
  posts: [
    { id: 1, title: 'First Post', content: 'This is the first post', userId: 1 },
    { id: 2, title: 'Second Post', content: 'This is the second post', userId: 2 },
    { id: 3, title: 'Third Post', content: 'This is the third post', userId: 1 }
  ]
};

function simulateSlowQuery(data, delay = 1000) {
  return new Promise(resolve => {
    setTimeout(() => resolve(data), delay);
  });
}

// API Routes with caching

// Get all users (cached)
app.get('/api/users', apiCache, async (req, res) => {
  try {
    console.log('Fetching users from "database"...');
    const users = await simulateSlowQuery(mockDatabase.users, 500);
    res.json({
      success: true,
      data: users,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get user by ID (cached)
app.get('/api/users/:id', apiCache, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    console.log(`Fetching user ${userId} from "database"...`);
    
    const user = mockDatabase.users.find(u => u.id === userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = await simulateSlowQuery(user, 300);
    res.json({
      success: true,
      data: userData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get posts (cached with query parameters)
app.get('/api/posts', apiCache, async (req, res) => {
  try {
    const { userId, limit = 10 } = req.query;
    console.log('Fetching posts from "database"...');
    
    let posts = mockDatabase.posts;
    if (userId) {
      posts = posts.filter(p => p.userId === parseInt(userId));
    }
    
    posts = posts.slice(0, parseInt(limit));
    const postsData = await simulateSlowQuery(posts, 400);
    
    res.json({
      success: true,
      data: postsData,
      count: postsData.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Expensive computation endpoint (cached)
app.get('/api/expensive', apiCache, async (req, res) => {
  try {
    console.log('Performing expensive computation...');
    
    // Simulate expensive operation
    const result = await new Promise(resolve => {
      setTimeout(() => {
        const data = {
          computation: 'fibonacci',
          input: 40,
          result: 102334155, // fibonacci(40)
          computed_at: new Date().toISOString(),
          execution_time: '2.1s'
        };
        resolve(data);
      }, 2100);
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cache Management API Routes

// Get cache statistics
app.get('/api/cache/stats', (req, res) => {
  try {
    const stats = cache.stats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all cache entries
app.get('/api/cache/entries', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const entries = cache.getAllEntries(limit);
    res.json({
      success: true,
      data: entries,
      count: entries.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get specific cache entry
app.get('/api/cache/:key', (req, res) => {
  try {
    const value = cache.get(req.params.key);
    if (value === null) {
      return res.status(404).json({ error: 'Cache key not found' });
    }
    
    res.json({
      success: true,
      data: {
        key: req.params.key,
        value: value,
        exists: true
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set cache entry
app.post('/api/cache/:key', (req, res) => {
  try {
    const { value, ttl } = req.body;
    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }
    
    cache.set(req.params.key, value, ttl);
    res.json({
      success: true,
      message: 'Cache entry set successfully',
      key: req.params.key
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete cache entry
app.delete('/api/cache/:key', (req, res) => {
  try {
    const deleted = cache.delete(req.params.key);
    res.json({
      success: true,
      deleted: deleted,
      key: req.params.key
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear all cache
app.delete('/api/cache', (req, res) => {
  try {
    cache.clear();
    res.json({
      success: true,
      message: 'All cache entries cleared'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual cache cleanup
app.post('/api/cache/cleanup', (req, res) => {
  try {
    const cleaned = cache.cleanup();
    res.json({
      success: true,
      message: `Removed ${cleaned} expired entries`
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cache: cache.db ? 'connected' : 'disconnected'
  });
});

// Basic HTML interface for testing
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Express SQLite Cache Demo</title>
        <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            .endpoint { background: #f5f5f5; padding: 10px; margin: 10px 0; border-radius: 5px; }
            .method { font-weight: bold; color: #0066cc; }
        </style>
    </head>
    <body>
        <h1>Express SQLite Cache Demo</h1>
        <h2>API Endpoints (Cached)</h2>
        <div class="endpoint">
            <span class="method">GET</span> /api/users - Get all users
        </div>
        <div class="endpoint">
            <span class="method">GET</span> /api/users/:id - Get user by ID
        </div>
        <div class="endpoint">
            <span class="method">GET</span> /api/posts?userId=1&limit=5 - Get posts with filters
        </div>
        <div class="endpoint">
            <span class="method">GET</span> /api/expensive - Expensive computation (2s delay)
        </div>
        
        <h2>Cache Management</h2>
        <div class="endpoint">
            <span class="method">GET</span> /api/cache/stats - Cache statistics
        </div>
        <div class="endpoint">
            <span class="method">GET</span> /api/cache/entries - All cache entries
        </div>
        <div class="endpoint">
            <span class="method">POST</span> /api/cache/:key - Set cache entry
        </div>
        <div class="endpoint">
            <span class="method">DELETE</span> /api/cache/:key - Delete cache entry
        </div>
        <div class="endpoint">
            <span class="method">DELETE</span> /api/cache - Clear all cache
        </div>
        
        <p><strong>Note:</strong> First request will be slow, subsequent requests will be cached and fast!</p>
        <p>Check response headers for cache status: <code>X-Cache-Hit</code> and <code>X-Cache-Key</code></p>
    </body>
    </html>
  `);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  cache.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down gracefully...');
  cache.close();
  process.exit(0);
});

module.exports = { app, cache, SQLiteCache };