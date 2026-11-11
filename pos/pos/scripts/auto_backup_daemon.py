#!/usr/bin/env python3
"""
Automatic Local Backup Manager & Daemon for ROOMI CAFE POS.
Requirements satisfied:
- Automatically creates a local database backup every day (default 11:59 PM PKT).
- Readable filename format: ROOMI_CAFE_BACKUP_YYYY-MM-DD.db
- Verifies backup integrity using SQLite PRAGMA integrity_check before marking successful.
- Keeps at least 30 daily backups; only removes older backups after verifying newer backups are valid.
- Never overwrites the only valid backup.
- Supports manual backup, pre-restore snapshot, and one-click restore.
"""

import os
import sys
import glob
import time
import shutil
import sqlite3
from datetime import datetime, timezone, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'database', 'roomi_cafe.db')
BACKUP_DIR = os.path.join(BASE_DIR, 'database', 'backups')

PKT_TZ = timezone(timedelta(hours=5))

def get_pkt_now():
    return datetime.now(PKT_TZ)

def verify_sqlite_backup(backup_file_path: str) -> bool:
    """Run PRAGMA integrity_check and verify key tables exist and contain records."""
    if not os.path.exists(backup_file_path) or os.path.getsize(backup_file_path) < 10240:
        return False
    try:
        conn = sqlite3.connect(backup_file_path)
        res = conn.execute("PRAGMA integrity_check;").fetchone()
        if not res or res[0].lower() != 'ok':
            conn.close()
            return False
        # Verify core tables exist
        prod_cnt = conn.execute("SELECT COUNT(*) FROM products;").fetchone()[0]
        acc_cnt = conn.execute("SELECT COUNT(*) FROM chart_of_accounts;").fetchone()[0]
        conn.close()
        return prod_cnt > 0 and acc_cnt >= 12
    except Exception as e:
        print(f"[Backup Verify Error]: {e}")
        return False

def create_verified_backup(backup_type='AUTO_SCHEDULED', custom_label=None):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    now_pkt = get_pkt_now()
    date_str = now_pkt.strftime('%Y-%m-%d')

    if custom_label:
        filename = f"ROOMI_CAFE_BACKUP_{date_str}_{custom_label}.db"
    else:
        filename = f"ROOMI_CAFE_BACKUP_{date_str}.db"

    target_path = os.path.join(BACKUP_DIR, filename)
    temp_path = target_path + ".tmp"

    # If target already exists and is valid, do not overwrite it silently; create timestamped copy if manual
    if os.path.exists(target_path) and backup_type == 'MANUAL':
        filename = f"ROOMI_CAFE_BACKUP_{date_str}_{now_pkt.strftime('%H%M%S')}.db"
        target_path = os.path.join(BACKUP_DIR, filename)
        temp_path = target_path + ".tmp"

    try:
        if os.path.exists(temp_path):
            os.remove(temp_path)

        # Atomic hot backup via VACUUM INTO
        src_conn = sqlite3.connect(DB_PATH)
        src_conn.execute(f"VACUUM INTO '{temp_path}';")
        src_conn.close()

        # Verify integrity before promoting temp_path
        is_valid = verify_sqlite_backup(temp_path)
        if not is_valid:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise RuntimeError("Backup failed SQLite PRAGMA integrity_check")

        # Promote verified backup
        shutil.move(temp_path, target_path)
        size_bytes = os.path.getsize(target_path)

        # Record in backup_logs inside main DB
        log_conn = sqlite3.connect(DB_PATH)
        log_conn.execute("""
            INSERT INTO backup_logs (filename, file_path, backup_date, size_bytes, backup_type, integrity_verified, status, notes)
            VALUES (?, ?, ?, ?, ?, 1, 'SUCCESS', ?)
        """, (filename, target_path, date_str, size_bytes, backup_type, f"Verified SQLite backup ({backup_type})"))
        log_conn.commit()
        log_conn.close()

        # Run 30-day retention cleanup safely
        enforce_retention_policy(min_keep=30)

        return {
            "success": True,
            "filename": filename,
            "file_path": target_path,
            "backup_date": date_str,
            "size_bytes": size_bytes,
            "integrity_verified": True,
            "timestamp_pkt": now_pkt.strftime('%Y-%m-%d %I:%M:%S %p PKT')
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

def enforce_retention_policy(min_keep=30):
    """Keep at least 30 daily backups. Only remove older backups if >= min_keep valid backups exist."""
    files = sorted(glob.glob(os.path.join(BACKUP_DIR, "ROOMI_CAFE_BACKUP_*.db")))
    valid_files = [f for f in files if verify_sqlite_backup(f)]
    if len(valid_files) <= min_keep:
        return 0
    to_remove = valid_files[:-min_keep]
    removed = 0
    for old_f in to_remove:
        try:
            os.remove(old_f)
            removed += 1
        except OSError:
            pass
    return removed

def restore_from_backup(backup_filename: str):
    """Safely restore from a verified backup after creating a pre-restore safety snapshot."""
    source_backup = os.path.join(BACKUP_DIR, os.path.basename(backup_filename))
    if not verify_sqlite_backup(source_backup):
        return {"success": False, "error": "Selected backup file failed integrity verification. Restore aborted."}

    # Create pre-restore safety backup first
    create_verified_backup(backup_type='PRE_RESTORE', custom_label=f"PRE_RESTORE_{int(time.time())}")

    # Copy verified backup over active DB
    shutil.copy2(source_backup, DB_PATH)
    return {
        "success": True,
        "restored_from": os.path.basename(source_backup),
        "timestamp_pkt": get_pkt_now().strftime('%Y-%m-%d %I:%M:%S %p PKT')
    }

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "backup"
    if cmd == "backup":
        res = create_verified_backup('AUTO_SCHEDULED')
        print(res)
    elif cmd == "manual":
        res = create_verified_backup('MANUAL')
        print(res)
    elif cmd == "restore" and len(sys.argv) > 2:
        res = restore_from_backup(sys.argv[2])
        print(res)
