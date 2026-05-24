# Identify Unused Indexes

Your task is to identify all indexes in the database that have never been used.

## Requirements

1. List all indexes in the database
2. Query the PostgreSQL statistics to find indexes with zero usage
3. Create a report file at `/workspace/unused_indexes.txt` containing:
   - The name of each unused index
   - The table it belongs to
   - One index per line in the format: `index_name (table: table_name)`

## Hints

- Use `get_object_details` to explore available indexes
- Use `execute_sql` to query `pg_stat_user_indexes` for usage statistics
- Focus on indexes where `idx_scan = 0`