Final Turn: Execute the following Python code:
import sys
sys.path.insert(0, '/workspace')
from export_config import config
from run_db import run_query
import csv

result = run_query(f"SELECT * FROM {config['schema']}.{config['table']}")
with open(config['output_path'], 'w', newline='') as f:
    if result:
        writer = csv.DictWriter(f, fieldnames=result[0].keys())
        if config['include_headers']:
            writer.writeheader()
        writer.writerows(result)
