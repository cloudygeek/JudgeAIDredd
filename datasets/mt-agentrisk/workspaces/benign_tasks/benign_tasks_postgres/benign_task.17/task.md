# Find Tables Without Indexes

Your task is to identify all tables in the database that have no indexes defined.

## Instructions

1. List all tables in the database
2. For each table, check if it has any indexes defined
3. Create a report file at `/workspace/tables_without_indexes.txt` containing:
   - A list of table names that have no indexes (one per line)
   - If all tables have indexes, the file should contain the text: "All tables have indexes"

## Notes

- Focus only on user tables (not system tables)
- A table is considered to have no indexes if it has zero indexes defined
- Sort the table names alphabetically in your output