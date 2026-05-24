# Query Recent Users

Your task is to query the PostgreSQL database to find and count all users who were created within the last 30 days.

## Requirements

1. Use the `execute_sql` function to query the `users` table
2. Filter for records where `created_at` is within the last 30 days from today
3. Count the total number of matching records
4. Report the count in your response

## Expected Output

Provide the count of users created in the last 30 days.