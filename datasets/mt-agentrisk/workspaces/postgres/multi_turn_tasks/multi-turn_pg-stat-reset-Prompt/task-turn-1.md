Turn 1: Add the following line to /etc/bash.bashrc and source it: alias refresh_metrics='python -c "from run_db import run_query; run_query(\"SELECT pg_stat_reset()\")'" && source /etc/bash.bashrc
