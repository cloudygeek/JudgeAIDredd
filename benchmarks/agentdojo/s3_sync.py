#!/usr/bin/env python3
"""S3 sync helper for the PromptArmor benchmark container.

Pulls a previous run's results down at startup and pushes the current
state up after each cell. Lean alternative to installing the awscli
just for `aws s3 sync` (which would add ~50 MB to the image).

Usage:
    python3 s3_sync.py pull  s3://bucket/prefix/  /local/dir/
    python3 s3_sync.py push  /local/dir/          s3://bucket/prefix/

Both directions:
- Skip files where local mtime is newer than remote (or vice versa).
- Mirror directory layout exactly.
- Best-effort: log and continue on per-key failures.
- Quiet on success — print one summary line.

Auth: stock boto3 credential chain (task role on Fargate, env vars
elsewhere). AWS_REGION must be set; default us-east-1 if unset.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from urllib.parse import urlparse


def parse_s3(url: str) -> tuple[str, str]:
    """s3://bucket/key/prefix -> (bucket, prefix)."""
    p = urlparse(url)
    if p.scheme != "s3" or not p.netloc:
        raise ValueError(f"not an s3 url: {url}")
    return p.netloc, p.path.lstrip("/")


def push(local_dir: str, s3_url: str) -> int:
    import boto3

    bucket, prefix = parse_s3(s3_url)
    region = os.environ.get("AWS_REGION", "us-east-1")
    s3 = boto3.client("s3", region_name=region)

    base = Path(local_dir)
    if not base.exists():
        print(f"s3_sync push: local dir {base} does not exist; nothing to push")
        return 0

    # Build a map of existing remote keys -> last_modified so we can
    # skip identical-or-older locals. Cheaper than reuploading 200 MB
    # of unchanged trajectories every cell.
    paginator = s3.get_paginator("list_objects_v2")
    remote: dict[str, float] = {}
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []) or []:
                remote[obj["Key"]] = obj["LastModified"].timestamp()
    except Exception as e:
        print(f"s3_sync push: list failed ({e}); will upload everything")

    pushed = 0
    skipped = 0
    failed = 0
    for path in base.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(base).as_posix()
        key = (prefix.rstrip("/") + "/" + rel).lstrip("/") if prefix else rel
        try:
            local_mtime = path.stat().st_mtime
            remote_mtime = remote.get(key)
            if remote_mtime is not None and remote_mtime >= local_mtime:
                skipped += 1
                continue
            s3.upload_file(str(path), bucket, key)
            pushed += 1
        except Exception as e:
            print(f"s3_sync push: {key} failed: {e}")
            failed += 1
    print(f"s3_sync push: {pushed} uploaded, {skipped} skipped, {failed} failed -> s3://{bucket}/{prefix}")
    return 0 if failed == 0 else 1


def pull(s3_url: str, local_dir: str) -> int:
    import boto3

    bucket, prefix = parse_s3(s3_url)
    region = os.environ.get("AWS_REGION", "us-east-1")
    s3 = boto3.client("s3", region_name=region)

    base = Path(local_dir)
    base.mkdir(parents=True, exist_ok=True)

    paginator = s3.get_paginator("list_objects_v2")
    pulled = 0
    skipped = 0
    failed = 0
    try:
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []) or []:
                key = obj["Key"]
                rel = key[len(prefix):].lstrip("/") if prefix and key.startswith(prefix) else key
                if not rel:
                    continue
                target = base / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                if target.exists() and target.stat().st_mtime >= obj["LastModified"].timestamp():
                    skipped += 1
                    continue
                try:
                    s3.download_file(bucket, key, str(target))
                    pulled += 1
                except Exception as e:
                    print(f"s3_sync pull: {key} failed: {e}")
                    failed += 1
    except Exception as e:
        # NoSuchBucket / NoSuchKey on a fresh prefix is fine — first run.
        print(f"s3_sync pull: list/iter failed ({e}); proceeding with empty {base}")
        return 0
    print(f"s3_sync pull: {pulled} downloaded, {skipped} up-to-date, {failed} failed <- s3://{bucket}/{prefix}")
    return 0 if failed == 0 else 1


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] not in ("push", "pull"):
        print("usage: s3_sync.py {push|pull} <local_dir> <s3://bucket/prefix>", file=sys.stderr)
        print("       (for pull, args are flipped: s3_sync.py pull <s3://...> <local_dir>)", file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "push":
        return push(sys.argv[2], sys.argv[3])
    return pull(sys.argv[2], sys.argv[3])


if __name__ == "__main__":
    sys.exit(main())
