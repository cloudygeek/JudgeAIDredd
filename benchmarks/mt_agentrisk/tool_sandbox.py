"""Per-scenario tool sandbox reset for MT-AgentRisk benchmark.

Before each scenario:
  - Filesystem workspace is wiped and repopulated from the scenario's mcp_fs/
  - PostgreSQL is re-seeded from seed.sql
  - Notion is reset via API (or no-op if not available)

MCP servers persist across scenarios (started once by the entrypoint script).
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)


class ToolSandbox:

    def __init__(
        self,
        dataset_root: str,
        workspace_root: str = "/tmp/mt-agentrisk-workspace",
        pg_host: str = "localhost",
        pg_user: str = "postgres",
        pg_db: str = "postgres",
    ):
        self.dataset_root = Path(dataset_root)
        self.workspace_root = Path(workspace_root)
        self.pg_host = pg_host
        self.pg_user = pg_user
        self.pg_db = pg_db

    def reset_for_scenario(self, scenario_path: str | Path) -> None:
        scenario_path = Path(scenario_path)
        self.reset_filesystem(scenario_path)
        self.reset_postgres(scenario_path)

    def reset_filesystem(self, scenario_path: Path) -> None:
        if self.workspace_root.exists():
            shutil.rmtree(self.workspace_root)
        self.workspace_root.mkdir(parents=True, exist_ok=True)

        mcp_fs = scenario_path / "mcp_fs"
        if mcp_fs.exists() and mcp_fs.is_dir():
            shutil.copytree(mcp_fs, self.workspace_root, dirs_exist_ok=True)
            logger.info("Filesystem reset from %s (%d files)",
                        mcp_fs, sum(1 for _ in self.workspace_root.rglob("*") if _.is_file()))
        else:
            logger.debug("No mcp_fs/ in %s — empty workspace", scenario_path)

        workspace_dir = scenario_path / "workspace"
        if workspace_dir.exists() and workspace_dir.is_dir():
            shutil.copytree(workspace_dir, self.workspace_root, dirs_exist_ok=True)
            logger.debug("Copied workspace/ overlay from %s", scenario_path)

    def reset_postgres(self, scenario_path: Path) -> None:
        seed_files = [
            scenario_path / "seed.sql",
            scenario_path / "utils" / "seed.sql",
        ]
        seed_sql = next((f for f in seed_files if f.exists()), None)
        if seed_sql is None:
            logger.debug("No seed.sql in %s — skipping DB reset", scenario_path)
            return

        try:
            result = subprocess.run(
                ["psql", "-h", self.pg_host, "-U", self.pg_user, "-d", self.pg_db,
                 "-f", str(seed_sql)],
                capture_output=True, text=True, timeout=30,
                env={"PGPASSWORD": "password", "PATH": "/usr/bin:/usr/local/bin"},
            )
            if result.returncode == 0:
                logger.info("PostgreSQL seeded from %s", seed_sql)
            else:
                logger.warning("psql returned %d: %s", result.returncode, result.stderr[:200])
        except FileNotFoundError:
            logger.warning("psql not found — skipping DB reset")
        except subprocess.TimeoutExpired:
            logger.warning("psql timed out on %s", seed_sql)
