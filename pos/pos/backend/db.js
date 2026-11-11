/**
 * Database client for Roomi Cafe POS backend.
 * Uses persistent child process with Python's built-in sqlite3 engine,
 * guaranteeing zero external npm dependency issues in standalone environments,
 * while maintaining sub-millisecond query speed and full ACID safety.
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class DatabaseClient {
  constructor(dbPath) {
    this.workerScript = path.join(__dirname, 'sqlite_worker.py');
    this.child = null;
    this.rl = null;
    this.pendingCallbacks = new Map();
    this.requestId = 1;
    this.isReady = false;
    this.readyPromise = this.init();
  }

  init() {
    return new Promise((resolve, reject) => {
      this.child = spawn('python3', [this.workerScript], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      this.rl = readline.createInterface({
        input: this.child.stdout,
        terminal: false
      });

      this.child.stderr.on('data', (data) => {
        console.error(`[SQLiteWorker Error]: ${data.toString()}`);
      });

      this.child.on('close', (code) => {
        console.warn(`[SQLiteWorker] Exited with code ${code}`);
        this.isReady = false;
      });

      this.rl.once('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.status === 'ready') {
            this.isReady = true;
            resolve();
          } else {
            reject(new Error(`Unexpected handshake: ${line}`));
          }
        } catch (err) {
          reject(err);
        }
      });

      this.rl.on('line', (line) => {
        try {
          const res = JSON.parse(line);
          if (res.id && this.pendingCallbacks.has(res.id)) {
            const cb = this.pendingCallbacks.get(res.id);
            this.pendingCallbacks.delete(res.id);
            if (res.success) {
              cb.resolve(res);
            } else {
              cb.reject(new Error(res.error || 'Database operation failed'));
            }
          }
        } catch (err) {
          console.error('[SQLiteWorker Parse Error]', err, line);
        }
      });
    });
  }

  async send(action, payload = {}) {
    await this.readyPromise;
    return new Promise((resolve, reject) => {
      const id = this.requestId++;
      this.pendingCallbacks.set(id, { resolve, reject });
      const req = { id, action, ...payload };
      this.child.stdin.write(JSON.stringify(req) + '\n');
    });
  }

  async query(sql, params = []) {
    const res = await this.send('query', { sql, params });
    return res.rows || [];
  }

  async queryOne(sql, params = []) {
    const rows = await this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  async execute(sql, params = []) {
    const res = await this.send('execute', { sql, params });
    return {
      lastInsertRowid: res.lastInsertRowid,
      changes: res.changes
    };
  }

  async executeMany(sql, paramsList = []) {
    const res = await this.send('execute_many', { sql, params: paramsList });
    return { changes: res.changes };
  }

  async transaction(statements) {
    const res = await this.send('transaction', { statements });
    return res.results || [];
  }

  close() {
    if (this.child) {
      this.child.kill();
    }
  }
}

const db = new DatabaseClient();
module.exports = db;
