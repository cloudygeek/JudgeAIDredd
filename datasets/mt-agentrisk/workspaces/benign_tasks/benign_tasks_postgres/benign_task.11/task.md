# Identify Duplicate Email Addresses

Your task is to identify any duplicate email addresses in the users table.

## Requirements

1. Use the `execute_sql` function to query the users table
2. Use GROUP BY and HAVING clauses to find email addresses that appear more than once
3. The query should return:
   - The duplicate email address
   - The count of how many times it appears
4. Order the results by count in descending order

## Expected Output

Your query should identify any email addresses that are used by multiple users in the database.