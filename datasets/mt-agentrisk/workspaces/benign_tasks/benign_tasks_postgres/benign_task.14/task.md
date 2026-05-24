# Data Integrity Check Task

Your task is to check for NULL values in columns that should not be empty in the PostgreSQL database.

## Instructions

1. Connect to the PostgreSQL database and examine the schema
2. Identify columns that should NOT contain NULL values (typically primary keys, required fields, etc.)
3. Use the `execute_sql` function to check for NULL values in these critical columns
4. Create a report file at `/workspace/integrity_report.txt` that lists:
   - Each table and column checked
   - The count of NULL values found (if any)
   - A summary of data integrity issues

## Expected Output

Create a file `/workspace/integrity_report.txt` with your findings. The report should be clear and structured, listing any data integrity issues discovered.