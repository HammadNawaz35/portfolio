#!/usr/bin/env python3
"""
High-Performance SQLite JSON-RPC Worker for Node.js Backend.
Reads JSON commands from stdin (line-delimited) and writes JSON responses to stdout.
Supports parameterized queries, executes, transactions, and row dictionary conversion.
"""

import sys
import os
import json
import sqlite3
import traceback

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'database', 'roomi_cafe.db')

def dict_factory(cursor, row):
    d = {}
    for idx, col in enumerate(cursor.description):
        d[col[0]] = row[idx]
    return d

class SQLiteWorker:
    def __init__(self, db_path=DB_PATH):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute("PRAGMA foreign_keys = ON;")
        self.conn.execute("PRAGMA journal_mode = WAL;")
        self.conn.row_factory = dict_factory

    def query(self, sql, params=()):
        cur = self.conn.cursor()
        cur.execute(sql, params)
        rows = cur.fetchall()
        return rows

    def execute(self, sql, params=()):
        cur = self.conn.cursor()
        cur.execute(sql, params)
        self.conn.commit()
        return {
            "lastInsertRowid": cur.lastrowid,
            "changes": cur.rowcount
        }

    def execute_many(self, sql, params_list):
        cur = self.conn.cursor()
        cur.executemany(sql, params_list)
        self.conn.commit()
        return {
            "changes": cur.rowcount
        }

    def transaction(self, statements):
        """
        Executes an atomic transaction with a list of dicts:
        [{'sql': '...', 'params': [...]}, ...]
        Returns array of results. Rolls back on error.
        """
        cur = self.conn.cursor()
        results = []
        try:
            self.conn.execute("BEGIN TRANSACTION;")
            for stmt in statements:
                sql = stmt['sql']
                params = stmt.get('params', ())
                cur.execute(sql, params)
                res = {
                    "lastInsertRowid": cur.lastrowid,
                    "changes": cur.rowcount
                }
                if cur.description:
                    res['rows'] = cur.fetchall()
                results.append(res)
            self.conn.commit()
            return {"success": True, "results": results}
        except Exception as e:
            self.conn.rollback()
            raise e

def main():
    worker = SQLiteWorker()
    # Signal ready
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            action = req.get("action")
            sql = req.get("sql", "")
            params = req.get("params", ())

            if action == "query":
                rows = worker.query(sql, params)
                res = {"id": req_id, "success": True, "rows": rows}
            elif action == "execute":
                meta = worker.execute(sql, params)
                res = {"id": req_id, "success": True, **meta}
            elif action == "execute_many":
                meta = worker.execute_many(sql, params)
                res = {"id": req_id, "success": True, **meta}
            elif action == "transaction":
                meta = worker.transaction(req.get("statements", []))
                res = {"id": req_id, **meta}
            elif action == "ping":
                res = {"id": req_id, "success": True, "message": "pong"}
            else:
                res = {"id": req_id, "success": False, "error": f"Unknown action: {action}"}

            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()
        except Exception as err:
            res = {
                "id": req.get("id") if 'req' in locals() and isinstance(req, dict) else None,
                "success": False,
                "error": str(err),
                "traceback": traceback.format_exc()
            }
            sys.stdout.write(json.dumps(res) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
