/**
 * Background Automatic Backup Scheduler for ROOMI CAFE POS Backend.
 * Runs inside the Node.js server process even if no POS browser window is open.
 * Checks PKT time every 60 seconds and triggers `scripts/auto_backup_daemon.py`
 * at the configured daily backup time (default 23:59 PKT) or on server boot if today's backup is missing.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const db = require('./db');

const DAEMON_SCRIPT = path.join(__dirname, '..', 'scripts', 'auto_backup_daemon.py');
const BACKUP_DIR = path.join(__dirname, '..', 'database', 'backups');

function getPKTDateAndTime() {
  const now = new Date();
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const timeStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Karachi',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now);
  return { dateStr, timeStr };
}

function runBackupProcess(mode = 'backup') {
  return new Promise((resolve, reject) => {
    execFile('python3', [DAEMON_SCRIPT, mode], (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(stderr || err.message));
      }
      resolve(stdout.trim());
    });
  });
}

let schedulerTimer = null;
let lastTriggeredDate = null;

function startBackupScheduler() {
  // Check immediately on startup if today's daily backup exists; if not, create it
  const { dateStr } = getPKTDateAndTime();
  const expectedFile = path.join(BACKUP_DIR, `ROOMI_CAFE_BACKUP_${dateStr}.db`);
  if (!fs.existsSync(expectedFile)) {
    runBackupProcess('backup')
      .then(() => { lastTriggeredDate = dateStr; })
      .catch(e => console.error('[AutoBackup Boot Error]:', e.message));
  }

  // Schedule 60-second check for 23:59 PKT (or admin-configured time)
  schedulerTimer = setInterval(async () => {
    try {
      const { dateStr: curDate, timeStr: curTime } = getPKTDateAndTime();
      const row = await db.queryOne("SELECT value FROM settings WHERE key = 'auto_backup_time_pkt'");
      const targetTime = row ? JSON.parse(row.value) : '23:59';
      if (curTime === targetTime && lastTriggeredDate !== curDate) {
        lastTriggeredDate = curDate;
        await runBackupProcess('backup');
        console.log(`[AutoBackup] Daily scheduled backup completed at ${curDate} ${curTime} PKT`);
      }
    } catch (err) {
      console.error('[AutoBackup Scheduler Error]:', err.message);
    }
  }, 60 * 1000);
}

function stopBackupScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
}

module.exports = {
  startBackupScheduler,
  stopBackupScheduler,
  runBackupProcess
};
