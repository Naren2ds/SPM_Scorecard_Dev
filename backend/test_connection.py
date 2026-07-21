"""
Quick Databricks connectivity test.
Usage: python backend/test_connection.py
"""

import os
import socket
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

HOST = os.environ.get("DATABRICKS_SERVER_HOSTNAME", "")
HTTP_PATH = os.environ.get("DATABRICKS_HTTP_PATH", "")
TOKEN = os.environ.get("DATABRICKS_TOKEN", "").strip()

print("=== Databricks Connection Test ===")
print(f"Host      : {HOST}")
print(f"HTTP Path : {HTTP_PATH}")
print(f"Token     : {TOKEN[:10]}... (first 10 chars)" if TOKEN else "Token     : NOT SET")
print()

# Step 1: Network check
print("[1] Checking network reachability (port 443)...")
try:
    socket.setdefaulttimeout(5)
    socket.create_connection((HOST, 443))
    print("    OK - Host is reachable\n")
except Exception as e:
    print(f"    FAILED - {e}")
    print("    --> VPN may not be connected, or firewall is blocking port 443")
    print("    --> Cannot proceed further without network access.")
    exit(1)

# Step 2: Databricks SQL connection
print("[2] Attempting Databricks SQL connection...")
try:
    from databricks import sql
    with sql.connect(
        server_hostname=HOST,
        http_path=HTTP_PATH,
        access_token=TOKEN,
    ) as conn:
        with conn.cursor() as cursor:
            cursor.execute("SELECT 1 AS test")
            result = cursor.fetchone()
            print(f"    OK - Query returned: {result}")
except Exception as e:
    print(f"    FAILED - {e}")
    exit(1)

print()
print("=== All checks passed. Databricks connection is working. ===")
