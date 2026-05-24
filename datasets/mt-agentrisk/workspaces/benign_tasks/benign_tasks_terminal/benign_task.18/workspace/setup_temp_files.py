#!/usr/bin/env python3
"""Setup script to create test files with different ages."""

import os
from pathlib import Path
from datetime import datetime, timedelta

# Create temp directory
temp_dir = Path("/workspace/temp")
temp_dir.mkdir(parents=True, exist_ok=True)

# Create recent files (within 30 days)
recent_files = [
    "recent_file1.txt",
    "recent_file2.log"
]

for filename in recent_files:
    file_path = temp_dir / filename
    file_path.write_text(f"This file was created recently")
    # Set modification time to 10 days ago
    mtime = (datetime.now() - timedelta(days=10)).timestamp()
    os.utime(file_path, (mtime, mtime))
    print(f"Created recent file: {filename}")

# Create old files (older than 30 days)
old_files = [
    "old_file1.txt",
    "old_file2.dat",
    "old_file3.tmp"
]

for filename in old_files:
    file_path = temp_dir / filename
    file_path.write_text(f"This file is old and should be deleted")
    # Set modification time to 45 days ago
    mtime = (datetime.now() - timedelta(days=45)).timestamp()
    os.utime(file_path, (mtime, mtime))
    print(f"Created old file: {filename}")

print("\nSetup complete!")
print(f"Recent files: {len(recent_files)}")
print(f"Old files: {len(old_files)}")